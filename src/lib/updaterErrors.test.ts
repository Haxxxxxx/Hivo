import { describe, expect, it } from "vitest";
import { isReadOnlyInstallError, updateErrorKind } from "./updaterErrors";

describe("updater errors", () => {
  it("recognises a read-only app location", () => {
    expect(isReadOnlyInstallError("Read-only file system (os error 30)")).toBe(true);
    expect(isReadOnlyInstallError("failed to rename: EROFS")).toBe(true);
    expect(isReadOnlyInstallError("Couldn't download: network timeout")).toBe(false);
    expect(isReadOnlyInstallError(undefined)).toBe(false);
  });
});

describe("update error kinds", () => {
  it("tells a connection problem from the rest", () => {
    expect(updateErrorKind("error sending request for url (https://example.invalid/latest.json)")).toBe("network");
    expect(updateErrorKind("operation timed out")).toBe("network");
    expect(updateErrorKind("dns error: failed to lookup address information")).toBe("network");
    expect(updateErrorKind("Read-only file system (os error 30)")).toBe("readOnly");
    expect(updateErrorKind("the signature is invalid")).toBe("other");
    expect(updateErrorKind(undefined)).toBe("other");
  });
});
