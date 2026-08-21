import { describe, it, expect } from "bun:test";
import { preferredCaptchaCdpPort } from "./captcha.js";

describe("preferredCaptchaCdpPort", () => {
  it("derives a unique CDP port from the listen port", () => {
    expect(preferredCaptchaCdpPort({ ZCODE_PROXY_PORT: "8082" })).toBe(18082);
    expect(preferredCaptchaCdpPort({ ZCODE_PROXY_PORT: "9000" })).toBe(19000);
  });

  it("lets ZCODE_CAPTCHA_CDP_PORT win", () => {
    expect(preferredCaptchaCdpPort({ ZCODE_PROXY_PORT: "8082", ZCODE_CAPTCHA_CDP_PORT: "9400" })).toBe(9400);
  });

  it("falls back to 9341", () => {
    expect(preferredCaptchaCdpPort({})).toBe(9341);
  });
});
