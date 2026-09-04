import { expect, test } from "@playwright/test";

import {
  createUser,
  createUserWithTwoFactor,
  deleteUserByEmail,
  generateTotpCode,
  uniqueEmail,
} from "./helpers";

const trackedEmails: string[] = [];

function track(email: string): string {
  trackedEmails.push(email);
  return email;
}

function randomBase32Secret(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

function randomRecoveryCode(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const chunk = () =>
    Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  return `${chunk()}-${chunk()}-${chunk()}-${chunk()}`;
}

test.afterAll(async () => {
  for (const email of trackedEmails) {
    await deleteUserByEmail(email);
  }
});

test.describe("Two-factor authentication", () => {
  test("full 2FA setup flow displays recovery codes once", async ({ page }) => {
    const email = track(uniqueEmail("2fa-setup"));
    await createUser(email, "Str0ngPass!");

    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill("Str0ngPass!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/notes/);

    await page.goto("/settings");
    await page.getByRole("button", { name: "Enable 2FA" }).click();

    await expect(page.getByText("Scan the QR code")).toBeVisible();
    const secret = await page.locator("code").innerText();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);

    const code = generateTotpCode(secret);
    await page.getByLabel("6-digit verification code").fill(code);
    await page.getByRole("button", { name: "Verify and enable" }).click();

    await expect(page.getByText("Recovery codes")).toBeVisible();
    await expect(
      page.getByText("Save these codes now. They are not shown again."),
    ).toBeVisible();
    const recoveryCodes = await page
      .locator("ul")
      .filter({ hasText: "-" })
      .locator("li")
      .allInnerTexts();
    expect(recoveryCodes).toHaveLength(10);
    for (const codeItem of recoveryCodes) {
      expect(codeItem).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    }

    await page.getByRole("button", { name: "I've saved my codes" }).click();
    await expect(
      page.getByText("Two-factor authentication", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Disable 2FA" })).toBeVisible();
  });

  test("login is intercepted by the TOTP challenge and passes on a valid code", async ({
    page,
  }) => {
    const email = track(uniqueEmail("2fa-login-totp"));
    const secret = randomBase32Secret();
    const recoveryCodes = [
      randomRecoveryCode(),
      randomRecoveryCode(),
      randomRecoveryCode(),
      randomRecoveryCode(),
      randomRecoveryCode(),
      randomRecoveryCode(),
      randomRecoveryCode(),
      randomRecoveryCode(),
      randomRecoveryCode(),
      randomRecoveryCode(),
    ];
    await createUserWithTwoFactor(email, "Str0ngPass!", secret, recoveryCodes);

    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill("Str0ngPass!");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(
      page.getByLabel(/6-digit code from your authenticator/),
    ).toBeVisible();

    await page
      .getByLabel(/6-digit code from your authenticator/)
      .fill(generateTotpCode(secret));
    await page.getByRole("button", { name: "Verify" }).click();

    await expect(page).toHaveURL(/\/notes/);
  });

  test("login is intercepted by the TOTP challenge but bypassed with a recovery code", async ({
    page,
  }) => {
    const email = track(uniqueEmail("2fa-login-recovery"));
    const secret = randomBase32Secret();
    const recoveryCode = randomRecoveryCode();
    const recoveryCodes = [recoveryCode, randomRecoveryCode(), randomRecoveryCode()];
    await createUserWithTwoFactor(email, "Str0ngPass!", secret, recoveryCodes);

    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill("Str0ngPass!");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(
      page.getByLabel(/6-digit code from your authenticator/),
    ).toBeVisible();

    await page.getByRole("button", { name: "Recovery code" }).click();
    await page.getByLabel(/Enter a recovery code/).fill(recoveryCode);
    await page.getByRole("button", { name: "Verify" }).click();

    await expect(page).toHaveURL(/\/notes/);
  });
});