import { expect, test, type Page } from "@playwright/test";

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

async function login(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/notes/);
}

function noteIdFromUrl(url: string): string {
  const pathname = new URL(url).pathname;
  return pathname.split("/").filter(Boolean).pop() ?? "";
}

test.afterAll(async () => {
  for (const email of trackedEmails) {
    await deleteUserByEmail(email);
  }
});

test.describe("Notes workspace lifecycle", () => {
  test("creates, edits, and deletes a note", async ({ page }) => {
    const email = track(uniqueEmail("note-crud"));
    await createUser(email, "Str0ngPass!");

    await login(page, email, "Str0ngPass!");

    await page.goto("/notes");
    await page.getByRole("button", { name: "New note" }).click();
    await page.waitForURL(/\/notes\/[0-9a-f-]{36}/);

    await expect(page.getByRole("link", { name: "Untitled note" })).toBeVisible();

    await page.getByLabel("Note title").fill("Groceries");
    await page.getByLabel("Note content").fill("Milk, eggs, bread");
    await page.getByRole("button", { name: "Save" }).click();

    await expect(page.getByText("Note saved")).toBeVisible();
    await expect(page.getByRole("link", { name: "Groceries" })).toBeVisible();

    const noteId = noteIdFromUrl(page.url());

    const versions = await sql<{ count: string }[]>`
      SELECT count(*) FROM note_versions WHERE note_id = ${noteId}
    `;
    expect(Number(versions[0].count)).toBe(1);

    const row = page.locator("li").filter({ hasText: "Groceries" });
    await row.hover();
    await row.getByRole("button", { name: "Delete Groceries" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Delete note?")).toBeVisible();
    await dialog.getByRole("button", { name: "Delete" }).click();

    await expect(page).toHaveURL(/\/notes$/);
    await expect(page.getByRole("link", { name: "Groceries" })).toHaveCount(0);

    const softDeleted = await sql<{ count: string }[]>`
      SELECT count(*) FROM notes WHERE id = ${noteId} AND deleted_at IS NOT NULL
    `;
    expect(Number(softDeleted[0].count)).toBe(1);
  });

  test("notes are isolated between users", async ({ browser }) => {
    const ownerEmail = track(uniqueEmail("note-owner"));
    const otherEmail = track(uniqueEmail("note-other"));
    await createUser(ownerEmail, "Str0ngPass!");
    await createUser(otherEmail, "Str0ngPass!");

    const ownerContext = await browser.newContext();
    const ownerPage = await ownerContext.newPage();
    await login(ownerPage, ownerEmail, "Str0ngPass!");

    await ownerPage.goto("/notes");
    await ownerPage.getByRole("button", { name: "New note" }).click();
    await ownerPage.waitForURL(/\/notes\/[0-9a-f-]{36}/);
    await ownerPage.getByLabel("Note title").fill("Secret plans");
    await ownerPage.getByRole("button", { name: "Save" }).click();
    await expect(ownerPage.getByText("Note saved")).toBeVisible();
    const noteId = noteIdFromUrl(ownerPage.url());

    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();
    await login(otherPage, otherEmail, "Str0ngPass!");

    await otherPage.goto("/notes");
    await expect(
      otherPage.getByRole("link", { name: "Secret plans" }),
    ).toHaveCount(0);

    await otherPage.goto(`/notes/${noteId}`);
    await expect(
      otherPage.getByText("This page could not be found"),
    ).toBeVisible();

    await otherContext.close();
    await ownerContext.close();
  });
});