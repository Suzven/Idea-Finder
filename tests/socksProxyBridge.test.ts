import net, { type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createAuthenticatedSocks5Bridge, type SocksProxyBridge } from "../server/services/socksProxyBridge";

function socketReader(socket: Socket) {
  let buffer = Buffer.alloc(0);
  const pending: Array<{ size: number; resolve: (value: Buffer) => void }> = [];
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (pending.length && buffer.length >= pending[0].size) {
      const request = pending.shift()!;
      const value = buffer.subarray(0, request.size);
      buffer = buffer.subarray(request.size);
      request.resolve(value);
    }
  });
  return (size: number) => {
    if (buffer.length >= size) {
      const value = buffer.subarray(0, size);
      buffer = buffer.subarray(size);
      return Promise.resolve(value);
    }
    return new Promise<Buffer>((resolve) => pending.push({ size, resolve }));
  };
}

describe("authenticated SOCKS5 bridge", () => {
  let bridge: SocksProxyBridge | undefined;
  let upstream: net.Server | undefined;

  afterEach(async () => {
    await bridge?.close();
    await new Promise<void>((resolve) => upstream?.close(() => resolve()) ?? resolve());
  });

  it("authenticates against the upstream proxy and relays tunnel data", async () => {
    const credentials: { username?: string; password?: string } = {};
    upstream = net.createServer((socket) => {
      const read = socketReader(socket);
      void (async () => {
        expect([...await read(3)]).toEqual([0x05, 0x01, 0x02]);
        socket.write(Buffer.from([0x05, 0x02]));
        const authHeader = await read(2);
        credentials.username = (await read(authHeader[1])).toString("utf8");
        const passwordLength = (await read(1))[0];
        credentials.password = (await read(passwordLength)).toString("utf8");
        socket.write(Buffer.from([0x01, 0x00]));
        const requestHeader = await read(4);
        expect([...requestHeader]).toEqual([0x05, 0x01, 0x00, 0x03]);
        const domainLength = (await read(1))[0];
        expect((await read(domainLength)).toString("utf8")).toBe("example.com");
        expect((await read(2)).readUInt16BE()).toBe(443);
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x01, 0xbb]));
        expect((await read(4)).toString("utf8")).toBe("PING");
        socket.write("PONG");
      })();
    });
    await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("Mock SOCKS5 server failed to listen");

    bridge = await createAuthenticatedSocks5Bridge(`socks5://127.0.0.1:${upstreamAddress.port}`, "proxy-user", "proxy-pass");
    const bridgeAddress = new URL(bridge.server);
    const client = net.createConnection({ host: bridgeAddress.hostname, port: Number(bridgeAddress.port) });
    await new Promise<void>((resolve) => client.once("connect", resolve));
    const readClient = socketReader(client);
    client.write(Buffer.from([0x05, 0x01, 0x00]));
    expect([...await readClient(2)]).toEqual([0x05, 0x00]);
    const domain = Buffer.from("example.com");
    const port = Buffer.alloc(2);
    port.writeUInt16BE(443);
    client.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, domain.length]), domain, port]));
    expect((await readClient(10))[1]).toBe(0x00);
    client.write("PING");
    expect((await readClient(4)).toString("utf8")).toBe("PONG");
    client.destroy();
    expect(credentials).toEqual({ username: "proxy-user", password: "proxy-pass" });
  });
});
