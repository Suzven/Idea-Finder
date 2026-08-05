import net, { type Server, type Socket } from "node:net";

interface PendingRead {
  size: number;
  resolve: (value: Buffer) => void;
  reject: (error: Error) => void;
}

class SocketReader {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private readonly pending: PendingRead[] = [];
  private ended = false;

  constructor(private readonly socket: Socket) {
    socket.on("data", this.onData);
    socket.on("error", this.onError);
    socket.on("end", this.onEnd);
    socket.on("close", this.onEnd);
  }

  private readonly onData = (chunk: Buffer) => {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    this.flush();
  };

  private readonly onError = (error: Error) => this.fail(error);
  private readonly onEnd = () => {
    this.ended = true;
    this.fail(new Error("SOCKS5-соединение закрылось во время установки туннеля."));
  };

  read(size: number): Promise<Buffer> {
    if (this.buffer.length >= size) {
      const value = this.buffer.subarray(0, size);
      this.buffer = this.buffer.subarray(size);
      return Promise.resolve(value);
    }
    if (this.ended) return Promise.reject(new Error("SOCKS5-соединение уже закрыто."));
    return new Promise((resolve, reject) => {
      this.pending.push({ size, resolve, reject });
      this.flush();
    });
  }

  detach(): Buffer {
    if (this.pending.length) throw new Error("Чтение SOCKS5-протокола ещё не завершено.");
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onError);
    this.socket.off("end", this.onEnd);
    this.socket.off("close", this.onEnd);
    const remainder = this.buffer;
    this.buffer = Buffer.alloc(0);
    return remainder;
  }

  private flush() {
    while (this.pending.length && this.buffer.length >= this.pending[0].size) {
      const request = this.pending.shift()!;
      const value = this.buffer.subarray(0, request.size);
      this.buffer = this.buffer.subarray(request.size);
      request.resolve(value);
    }
  }

  private fail(error: Error) {
    while (this.pending.length) this.pending.shift()!.reject(error);
  }
}

function write(socket: Socket, buffer: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      socket.off("error", onError);
      reject(error);
    };
    socket.once("error", onError);
    socket.write(buffer, () => {
      socket.off("error", onError);
      resolve();
    });
  });
}

function connect(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const onError = (error: Error) => reject(error);
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      socket.setNoDelay(true);
      resolve(socket);
    });
  });
}

async function readSocksAddress(reader: SocketReader, addressType: number): Promise<Buffer> {
  if (addressType === 0x01) return reader.read(4);
  if (addressType === 0x04) return reader.read(16);
  if (addressType === 0x03) {
    const length = await reader.read(1);
    return Buffer.concat([length, await reader.read(length[0])]);
  }
  throw new Error(`SOCKS5 вернул неизвестный тип адреса: ${addressType}.`);
}

async function handleConnection(client: Socket, upstream: URL, username: string, password: string, sockets: Set<Socket>): Promise<void> {
  let upstreamSocket: Socket | undefined;
  const clientReader = new SocketReader(client);
  try {
    client.setNoDelay(true);
    const greeting = await clientReader.read(2);
    if (greeting[0] !== 0x05) throw new Error("Chromium отправил неподдерживаемую версию SOCKS.");
    await clientReader.read(greeting[1]);
    await write(client, Buffer.from([0x05, 0x00]));

    const requestHeader = await clientReader.read(4);
    if (requestHeader[0] !== 0x05 || requestHeader[1] !== 0x01) throw new Error("Локальный мост поддерживает только SOCKS5 CONNECT.");
    const requestAddress = await readSocksAddress(clientReader, requestHeader[3]);
    const requestPort = await clientReader.read(2);
    const request = Buffer.concat([requestHeader, requestAddress, requestPort]);

    upstreamSocket = await connect(upstream.hostname, Number(upstream.port || 1080));
    sockets.add(upstreamSocket);
    const upstreamReader = new SocketReader(upstreamSocket);
    const authenticated = Boolean(username || password);
    await write(upstreamSocket, Buffer.from([0x05, 0x01, authenticated ? 0x02 : 0x00]));
    const selectedMethod = await upstreamReader.read(2);
    if (selectedMethod[0] !== 0x05 || selectedMethod[1] === 0xff) throw new Error("Внешняя SOCKS5-прокси отклонила методы авторизации.");
    if (selectedMethod[1] === 0x02) {
      const usernameBuffer = Buffer.from(username, "utf8");
      const passwordBuffer = Buffer.from(password, "utf8");
      if (usernameBuffer.length > 255 || passwordBuffer.length > 255) throw new Error("Логин или пароль SOCKS5 длиннее 255 байт.");
      await write(upstreamSocket, Buffer.concat([
        Buffer.from([0x01, usernameBuffer.length]),
        usernameBuffer,
        Buffer.from([passwordBuffer.length]),
        passwordBuffer,
      ]));
      const authResponse = await upstreamReader.read(2);
      if (authResponse[0] !== 0x01 || authResponse[1] !== 0x00) throw new Error("Внешняя SOCKS5-прокси отклонила логин или пароль.");
    } else if (selectedMethod[1] !== 0x00) {
      throw new Error(`Внешняя SOCKS5-прокси выбрала неподдерживаемый метод авторизации: ${selectedMethod[1]}.`);
    }

    await write(upstreamSocket, request);
    const responseHeader = await upstreamReader.read(4);
    const responseAddress = await readSocksAddress(upstreamReader, responseHeader[3]);
    const responsePort = await upstreamReader.read(2);
    await write(client, Buffer.concat([responseHeader, responseAddress, responsePort]));
    if (responseHeader[1] !== 0x00) throw new Error(`Внешняя SOCKS5-прокси отклонила подключение, код ${responseHeader[1]}.`);

    const pendingClientData = clientReader.detach();
    const pendingUpstreamData = upstreamReader.detach();
    if (pendingClientData.length) upstreamSocket.write(pendingClientData);
    if (pendingUpstreamData.length) client.write(pendingUpstreamData);
    client.on("error", () => upstreamSocket?.destroy());
    upstreamSocket.on("error", () => client.destroy());
    client.pipe(upstreamSocket).pipe(client);
  } catch (error) {
    if (!client.destroyed) {
      client.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      client.destroy(error instanceof Error ? error : new Error(String(error)));
    }
    upstreamSocket?.destroy();
  } finally {
    client.once("close", () => sockets.delete(client));
    if (upstreamSocket) upstreamSocket.once("close", () => sockets.delete(upstreamSocket!));
  }
}

export interface SocksProxyBridge {
  server: string;
  close: () => Promise<void>;
}

export async function createAuthenticatedSocks5Bridge(proxyServer: string, username = "", password = ""): Promise<SocksProxyBridge> {
  const upstream = new URL(proxyServer);
  if (upstream.protocol !== "socks5:") throw new Error("Локальный мост поддерживает только socks5:// прокси.");
  const effectiveUsername = username || decodeURIComponent(upstream.username);
  const effectivePassword = password || decodeURIComponent(upstream.password);
  upstream.username = "";
  upstream.password = "";
  const sockets = new Set<Socket>();
  const server: Server = net.createServer((client) => {
    sockets.add(client);
    void handleConnection(client, upstream, effectiveUsername, effectivePassword, sockets);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Не удалось определить локальный порт SOCKS5-моста.");
  }
  return {
    server: `socks5://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}
