import { expect, test } from "@playwright/test";

import {
  createUser,
  deleteUserByEmail,
  sql,
  uniqueEmail,
} from "./helpers";

const trackedEmails: string[] = [];

function track(email: string): string {
  trackedEmails.push(email);
  return email;
}

test.afterAll(async () => {
  for (const email of trackedEmails) {
    await deleteUserByEmail(email);
  }
  await sql.end();
});

test.describe("Authentication journeys", () => {
  test("successful registration redirects to /notes with toast", async ({
    page,
  }) => {
    const email = track(uniqueEmail("reg"));
    await page.goto("/register");

    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill("Str0ngPass!");
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page).toHaveURL(/\/notes/);
    await expect(
      page.getByText("Account created. Welcome!"),
    ).toBeVisible();
  });

  test("registration fails validation with inline errors and stays on page", async ({
    page,
  }) => {
    await page.goto("/register");

    await page.getByLabel("Email", { exact: true }).fill("not-an-email");
    await page.getByLabel("Password", { exact: true }).fill("weak");
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page.getByText("Invalid email address")).toBeVisible();
    await expect(
      page.getByText("Password must be at least 8 characters"),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/register/);
  });

  test("registration with an existing email surfaces a duplicate error", async ({
    page,
  }) => {
    const email = track(uniqueEmail("dup"));
    await createUser(email, "Str0ngPass!");

    await page.goto("/register");
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill("Str0ngPass!");
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(
      page
        .getByText("An account with this email already exists")
        .first(),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/register/);
  });

  test("successful login redirects to /notes with toast", async ({ page }) => {
    const email = track(uniqueEmail("login"));
    await createUser(email, "Str0ngPass!");

    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill("Str0ngPass!");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL(/\/notes/);
    await expect(page.getByText("Welcome back!")).toBeVisible();
  });

  test("login fails with invalid credentials", async ({ page }) => {
    await page.goto("/login");

    await page
      .getByLabel("Email", { exact: true })
      .fill(track(uniqueEmail("bad")));
    await page.getByLabel("Password", { exact: true }).fill("WrongPass!99");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(
      page.getByText("Invalid email or password").first(),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });
});