import { describe, expect, it } from "vitest";
import { verifyPassword } from "../server/auth";

const adminHash = "scrypt$v1$QNLgMCZLIsp-g2PNDfFYMA$auUhqrWBmC6psATKu6J4nsK74duA3FLMx8ClPtO_q4oSMTFgfuAI5_1jlCgbtsSNmxsYE65MmXIh54bP4jn3xQ";

describe("password authentication", () => {
  it("accepts the migrated admin password", async () => {
    await expect(verifyPassword("логин12344321!", adminHash)).resolves.toBe(true);
  });

  it("rejects a wrong password and malformed hashes", async () => {
    await expect(verifyPassword("wrong-password", adminHash)).resolves.toBe(false);
    await expect(verifyPassword("логин12344321!", "plain-text-password")).resolves.toBe(false);
  });
});
