import { describe, expect, it } from "vitest";
import { PasswordService } from "@/modules/auth/services/password.service.js";

describe("PasswordService", () => {
  const service = new PasswordService();

  it("hashes with Argon2id and verifies correctly", async () => {
    const hash = await service.hash("correct horse battery staple");

    expect(hash).toContain("$argon2id$");
    await expect(service.verify(hash, "correct horse battery staple")).resolves.toBe(true);
    await expect(service.verify(hash, "wrong password here!")).resolves.toBe(false);
  });

  it("rejects short passwords without trimming", async () => {
    await expect(service.hash("short")).rejects.toThrow("between 12 and 128");

    // Leading/trailing spaces are significant: an 11-char core padded to 12 counts as 12.
    const hash = await service.hash("  twelve chars  ");

    await expect(service.verify(hash, "twelve chars")).resolves.toBe(false);
    await expect(service.verify(hash, "  twelve chars  ")).resolves.toBe(true);
  });

  it("returns false for malformed hashes instead of throwing", async () => {
    await expect(service.verify("not-a-hash", "whatever password")).resolves.toBe(false);
  });
});
