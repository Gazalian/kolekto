import { expect, test } from "vitest";
import { safeRedirectPath } from "./safe-redirect.ts";

test("valid internal path is returned as-is", () => {
  expect(safeRedirectPath("/communities")).toBe("/communities");
  expect(safeRedirectPath("/c/my-community")).toBe("/c/my-community");
  expect(safeRedirectPath("/c/my-community/collections")).toBe("/c/my-community/collections");
  expect(safeRedirectPath("/account")).toBe("/account");
});

test("external https URL falls back to default", () => {
  expect(safeRedirectPath("https://evil.com")).toBe("/communities");
});

test("external http URL falls back to default", () => {
  expect(safeRedirectPath("http://evil.com")).toBe("/communities");
});

test("protocol-relative URL falls back to default", () => {
  expect(safeRedirectPath("//evil.com")).toBe("/communities");
});

test("javascript: protocol falls back to default", () => {
  expect(safeRedirectPath("javascript:alert(1)")).toBe("/communities");
});

test("malformed values fall back to default", () => {
  expect(safeRedirectPath("")).toBe("/communities");
  expect(safeRedirectPath(null)).toBe("/communities");
  expect(safeRedirectPath(undefined)).toBe("/communities");
  expect(safeRedirectPath("evil.com")).toBe("/communities");
  expect(safeRedirectPath("/\\evil.com")).toBe("/communities");
});

test("missing next parameter falls back to default", () => {
  expect(safeRedirectPath(null)).toBe("/communities");
  expect(safeRedirectPath(undefined)).toBe("/communities");
});

test("path with query string is preserved", () => {
  expect(safeRedirectPath("/c/slug?tab=settings")).toBe("/c/slug?tab=settings");
});

test("embedded protocol in path segment does not trigger rejection", () => {
  expect(safeRedirectPath("/c/my-community")).toBe("/c/my-community");
});
