import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import type { Browser, BrowserContext, Dialog, Frame, Locator, Page } from "playwright-core";

type Scope = Page | Frame;
type LocatorFactory = (scope: Scope) => Locator[];
type WindowToggle = (force?: boolean) => void | Promise<void>;

interface FormResult {
  ok: boolean;
  code?: string;
  message?: string;
  html?: string;
  tags?: string[];
  dialogMessage?: string;
  attempted?: boolean;
  region?: string;
  status?: string;
  pageUrl?: string;
  skipped?: boolean;
  [key: string]: unknown;
}

interface HttpResult {
  status: number;
  body: any;
}

interface ActiveServer {
  host: string;
  port: number;
  openLogin: typeof openLogin;
  openTistoryLogin: typeof openTistoryLogin;
  close(): Promise<void>;
}

let HOST = "127.0.0.1";
let PORT = Number(process.env.BROWSER_AUTOMATION_PORT ?? 4317);
let PROFILE_DIR = path.resolve(process.env.BROWSER_AUTOMATION_PROFILE_DIR ?? ".browser-automation-profile");
const LOGIN_URL = "https://m.knou.ac.kr/login?service=https%3A%2F%2Fm.knou.ac.kr";
const TISTORY_LOGIN_URL = "https://www.tistory.com/auth/login";
const TISTORY_CUSTOM_HOSTS = new Set(
  (process.env.TISTORY_CUSTOM_HOSTS ?? "blog.growthlog.org")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
);
const MAX_BODY_BYTES = 80_000_000;

function positiveNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

const ACTION_TIMEOUT_MS = positiveNumber(process.env.BROWSER_AUTOMATION_ACTION_TIMEOUT_MS, 20_000);
const NAVIGATION_TIMEOUT_MS = positiveNumber(process.env.BROWSER_AUTOMATION_NAVIGATION_TIMEOUT_MS, 30_000);
const POST_FORM_TIMEOUT_MS = positiveNumber(process.env.BROWSER_AUTOMATION_POST_FORM_TIMEOUT_MS, 30_000);
const POST_COMPLETION_PATTERN = /(등록|저장).{0,20}(완료|되었습니다|성공)|완료되었습니다/;
let allowedOrigins = new Set(
  (process.env.BROWSER_AUTOMATION_ALLOWED_ORIGINS ?? "http://localhost:3000,http://localhost:3001,http://127.0.0.1:3000,http://127.0.0.1:3001")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);
let authorizePairedOrigin: (origin: string, token: string) => boolean = () => false;

let browserContext: BrowserContext | undefined;
let browserConnection: Browser | undefined;
let workPage: Page | undefined;
let embeddedBrowserEndpoint = "";
let embeddedAutomationPageUrl = "";
let showEmbeddedBrowser: WindowToggle = async () => undefined;
let hideEmbeddedBrowser: WindowToggle = async () => undefined;
let activeServer: ActiveServer | undefined;

// 하나의 자동화 탭을 여러 요청이 동시에 조작하면 페이지 이동과 입력이 서로
// 덮어씌워집니다. 모든 브라우저 작업은 이 큐를 통해 한 건씩 실행합니다.
export function createBrowserTaskQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;

  return {
    get pending() {
      return pending;
    },
    async run<T>(task: () => T | Promise<T>): Promise<T> {
      pending += 1;
      const current = tail.then(() => task());
      tail = current.catch(() => undefined);
      try {
        return await current;
      } finally {
        pending -= 1;
      }
    },
  };
}

const browserTaskQueue = createBrowserTaskQueue();

function json(response: http.ServerResponse, status: number, value: unknown, origin = ""): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
  });
  response.end(JSON.stringify(value));
}

function isPotentialOrigin(origin: string): boolean {
  if (!origin || allowedOrigins.has(origin)) return true;

  try {
    const url = new URL(origin);
    return url.protocol === "https:"
      || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname));
  } catch {
    return false;
  }
}

function isAuthorizedRequest(request: http.IncomingMessage, origin: string): boolean {
  if (!origin || allowedOrigins.has(origin)) return true;
  try {
    const url = new URL(origin);
    if (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)) return true;
  } catch {
    return false;
  }
  const token = String(request.headers["x-growth-log-token"] ?? "");
  return Boolean(token) && authorizePairedOrigin(origin, token);
}

function isKnouUrl(value: unknown): boolean {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && (url.hostname === "knou.ac.kr" || url.hostname.endsWith(".knou.ac.kr"));
  } catch {
    return false;
  }
}

function tistoryUrl(value: unknown): URL | null {
  try {
    const raw = String(value ?? "").trim();
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const isTistoryHost = url.hostname === "tistory.com"
      || url.hostname === "www.tistory.com"
      || url.hostname.endsWith(".tistory.com")
      || TISTORY_CUSTOM_HOSTS.has(url.hostname);
    return url.protocol === "https:" && isTistoryHost ? url : null;
  } catch {
    return null;
  }
}

export function normalizeTistoryManageUrl(value: unknown): string {
  const url = tistoryUrl(value);
  if (!url || ["tistory.com", "www.tistory.com"].includes(url.hostname)) return "";
  return `${url.origin}/manage/newpost/?type=post&returnURL=%2Fmanage%2Fposts%2F`;
}

export function normalizeTistoryTags(value: unknown): string[] {
  const candidates = Array.isArray(value)
    ? value
    : String(value ?? "").split(/[\n,]+/);
  const unique: string[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const tag = String(candidate ?? "").trim().replace(/^#+/, "").trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    unique.push(tag.slice(0, 50));
    if (unique.length === 10) break;
  }
  return unique;
}

async function readBody(request: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("요청 본문이 너무 큽니다.");
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function getContext(): Promise<BrowserContext> {
  if (browserContext) return browserContext;

  if (embeddedBrowserEndpoint) {
    const deadline = Date.now() + 10_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        browserConnection = await chromium.connectOverCDP(embeddedBrowserEndpoint);
        break;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    if (!browserConnection) {
      throw lastError ?? new Error("Electron 자동화 브라우저에 연결하지 못했습니다.");
    }

    const contexts = browserConnection.contexts();
    browserContext = contexts[0];
    workPage = contexts
      .flatMap((context) => context.pages())
      .find((page) => page.url() === embeddedAutomationPageUrl);
    if (!browserContext || !workPage) {
      throw new Error("Electron 자동화 브라우저 화면을 찾지 못했습니다.");
    }
    browserConnection.on("disconnected", () => {
      browserConnection = undefined;
      browserContext = undefined;
      workPage = undefined;
    });
    return browserContext;
  }

  browserContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome",
    headless: false,
    viewport: null,
  });
  browserContext.on("close", () => {
    browserContext = undefined;
  });
  return browserContext;
}

async function getWorkPage(): Promise<Page> {
  const context = await getContext();
  if (workPage && !workPage.isClosed()) {
    workPage.setDefaultTimeout(ACTION_TIMEOUT_MS);
    return workPage;
  }
  const pages = context.pages();
  const page = pages.find((candidate) => candidate.url() === "about:blank") ?? (await context.newPage());
  workPage = page;
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  return page;
}

// 사람이 직접 확인·작업해야 하는 순간(로그인·검토 대기·직접 처리 안내)에만 방송대 창을 앞으로 가져옵니다.
// 자동 이동·채우기·제출 단계에서는 포커스를 뺏지 않아 사용자가 그동안 다른 작업을 계속할 수 있습니다.
async function surfaceForUser(page: Page, force = false): Promise<void> {
  if (embeddedBrowserEndpoint) {
    await showEmbeddedBrowser(force);
    return;
  }
  await page.bringToFront().catch(() => undefined);
}

async function prepareBrowserInBackground(): Promise<void> {
  if (!embeddedBrowserEndpoint) return;
  await hideEmbeddedBrowser();
}

async function firstVisible(locators: Locator[]): Promise<Locator | null> {
  for (const locator of locators) {
    const count = Math.min(await locator.count(), 12);
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
      // 화면 밖(스크롤 아래)이라 안 보이면 뷰로 스크롤한 뒤 다시 확인합니다.
      await candidate.scrollIntoViewIfNeeded().catch(() => undefined);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  return null;
}

function searchScopes(page: Page): Scope[] {
  return [
    page,
    ...page.frames().filter((frame) => frame !== page.mainFrame()),
  ];
}

// 페이지(또는 프레임)를 아래까지 단계적으로 스크롤해 지연 렌더링 요소를 노출시킨 뒤 맨 위로 돌아옵니다.
async function revealByScrolling(scope: Scope): Promise<void> {
  await scope.evaluate(async () => {
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const doc = document.scrollingElement || document.documentElement;
    const step = Math.max(window.innerHeight * 0.8, 400);
    for (let y = 0; y <= doc.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await wait(120);
    }
    window.scrollTo(0, 0);
  }).catch(() => undefined);
}

async function firstVisibleAcrossFrames(page: Page, createLocators: LocatorFactory): Promise<Locator | null> {
  for (const scope of searchScopes(page)) {
    const candidate = await firstVisible(createLocators(scope)).catch(() => null);
    if (candidate) return candidate;
  }

  // 첫 탐색에서 못 찾으면 스크롤로 화면 밖/지연 로딩 요소를 노출시킨 뒤 한 번 더 찾습니다.
  for (const scope of searchScopes(page)) {
    await revealByScrolling(scope);
  }
  for (const scope of searchScopes(page)) {
    const candidate = await firstVisible(createLocators(scope)).catch(() => null);
    if (candidate) return candidate;
  }
  return null;
}

async function firstExistingAcrossFrames(page: Page, createLocators: LocatorFactory): Promise<Locator | null> {
  for (const scope of searchScopes(page)) {
    for (const locator of createLocators(scope)) {
      if ((await locator.count().catch(() => 0)) > 0) return locator.first();
    }
  }
  return null;
}

function titleLocators(scope: Scope): Locator[] {
  return [
    scope.locator("#post-title-inp"),
    scope.locator('textarea[placeholder*="제목"]'),
    scope.locator('input[placeholder*="제목"]'),
    scope.locator('input[name="artclSj"]'),
    scope.locator("#artclSj"),
    scope.getByLabel(/제목/),
    scope.locator('input[name*="title" i]'),
    scope.locator('input[name*="sj" i]'),
  ];
}

const WRITE_ACCESSIBILITY_NOTICE =
  /장애인\s*웹\s*접근성\s*준수[\s\S]*이미지를\s*붙여넣기[\s\S]*저장되지\s*않습니다/;

async function acceptWriteAccessibilityNotice(page: Page): Promise<boolean> {
  for (const scope of searchScopes(page)) {
    const knouAffirmative = await firstVisible([
      scope.locator(
        'input.confirmBtnOk[type="button"][value="YES" i], '
        + 'input.confirmBtnOk[type="submit"][value="YES" i]',
      ),
    ]).catch(() => null);
    const knouNoticeText = await firstVisible([
      scope.getByText(/장애인\s*웹\s*접근성\s*준수/),
      scope.getByText(/이미지를\s*붙여넣기.*저장되지\s*않습니다/),
    ]).catch(() => null);

    if (knouAffirmative && knouNoticeText) {
      await knouAffirmative.scrollIntoViewIfNeeded().catch((): void => undefined);
      await knouAffirmative.click({ timeout: 5_000 }).catch(async () => {
        await knouAffirmative.evaluate((element: HTMLElement | SVGElement) => {
          if (element instanceof HTMLElement) element.click();
        });
      });
      return true;
    }

    const notice = await firstVisible([
      scope.getByRole("dialog").filter({ hasText: WRITE_ACCESSIBILITY_NOTICE }),
      scope.getByRole("alertdialog").filter({ hasText: WRITE_ACCESSIBILITY_NOTICE }),
      scope.locator(
        '.modal-content, .modal-dialog, .ui-dialog, .swal2-popup, .bootbox, '
        + '[class*="layerPopup" i], [class*="popup" i]',
      ).filter({ hasText: WRITE_ACCESSIBILITY_NOTICE }),
    ]).catch(() => null);

    if (!notice) continue;

    const affirmative = await firstVisible([
      notice.getByRole("button", { name: /^(YES|예|확인)$/i }),
      notice.getByRole("link", { name: /^(YES|예|확인)$/i }),
      notice.locator(
        'input[type="button"][value="YES" i], input[type="submit"][value="YES" i], '
        + 'input[type="button"][value="예"], input[type="submit"][value="예"], '
        + 'input[type="button"][value="확인"], input[type="submit"][value="확인"]',
      ),
    ]).catch(() => null);

    if (!affirmative) return false;

    await affirmative.scrollIntoViewIfNeeded().catch((): void => undefined);
    await affirmative.click({ timeout: 5_000 }).catch(async () => {
      await affirmative.evaluate((element: HTMLElement | SVGElement) => {
        if (element instanceof HTMLElement) element.click();
      });
    });
    return true;
  }

  return false;
}

async function waitForPostForm(page: Page, timeoutMs = POST_FORM_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await acceptWriteAccessibilityNotice(page);
    if (await firstVisibleAcrossFrames(page, titleLocators)) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

async function clickFormControl(page: Page, createLocators: LocatorFactory): Promise<Page | null> {
  const control = await firstVisibleAcrossFrames(page, createLocators);
  if (!control) return null;

  await control.scrollIntoViewIfNeeded().catch(() => undefined);
  const popupPromise = page.waitForEvent("popup", { timeout: 1_500 }).catch(() => null);
  await control.click({ timeout: ACTION_TIMEOUT_MS }).catch(async () => {
    await control.evaluate((element: HTMLElement | SVGElement) => {
      if (element instanceof HTMLElement) element.click();
    });
  });

  const popup = await popupPromise;
  const targetPage = popup ?? page;
  await targetPage.waitForLoadState("domcontentloaded", { timeout: NAVIGATION_TIMEOUT_MS }).catch((): void => undefined);
  return (await waitForPostForm(targetPage)) ? targetPage : null;
}

export function openEditForm(page: Page): Promise<Page | null> {
  return clickFormControl(page, (scope) => [
    scope.getByRole("link", { name: /^(게시글\s*)?(글\s*)?(수정|편집)$/ }),
    scope.getByRole("button", { name: /^(게시글\s*)?(글\s*)?(수정|편집)$/ }),
    scope.locator(
      'input[type="button"][value*="수정"], input[type="submit"][value*="수정"], '
      + 'input[type="button"][value*="편집"], input[type="submit"][value*="편집"]',
    ),
    scope.locator("a, button").filter({ hasText: /^(게시글\s*)?(글\s*)?(수정|편집)$/ }),
    scope.locator(
      'a[href*="update" i], a[href*="modify" i], button[onclick*="update" i], '
      + 'button[onclick*="modify" i], a[onclick*="update" i], a[onclick*="modify" i]',
    ),
  ]);
}

export function openWriteForm(page: Page): Promise<Page | null> {
  return clickFormControl(page, (scope) => [
    scope.getByRole("link", { name: /^(새\s*글(\s*쓰기)?|글\s*쓰기|게시글\s*(쓰기|작성)|글\s*작성|작성)$/ }),
    scope.getByRole("button", { name: /^(새\s*글(\s*쓰기)?|글\s*쓰기|게시글\s*(쓰기|작성)|글\s*작성|작성)$/ }),
    scope.locator(
      'input[type="button"][value*="글쓰기"], input[type="submit"][value*="글쓰기"], '
      + 'input[type="button"][value*="작성"], input[type="submit"][value*="작성"]',
    ),
    scope.locator("a, button").filter({
      hasText: /^(새\s*글(\s*쓰기)?|글\s*쓰기|게시글\s*(쓰기|작성)|글\s*작성|작성)$/,
    }),
    scope.locator(
      'a[href*="write" i], a[href*="insert" i], button[onclick*="write" i], '
      + 'button[onclick*="insert" i], a[onclick*="write" i], a[onclick*="insert" i]',
    ),
  ]);
}

async function fillTitle(page: Page, title: string): Promise<boolean> {
  const titleField = await firstVisibleAcrossFrames(page, titleLocators);

  if (!titleField) return false;
  await titleField.fill(title);
  return true;
}

async function assignHtml(locator: Locator, html: string): Promise<void> {
  await locator.evaluate((element, nextHtml) => {
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      element.value = nextHtml;
    } else {
      element.innerHTML = nextHtml;
    }
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: null }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, html);
}

async function fillHtml(page: Page, html: string): Promise<boolean> {
  let filledEditor = false;

  const pageEditor = await firstVisibleAcrossFrames(page, (scope) => [
    scope.locator('[contenteditable="true"][role="textbox"]'),
    scope.locator(".cke_editable, .toastui-editor-contents[contenteditable='true'], .ProseMirror"),
    scope.locator('body[contenteditable="true"]'),
    scope.locator('[contenteditable="true"]'),
  ]);
  if (pageEditor) {
    await assignHtml(pageEditor, html);
    filledEditor = true;
  }

  const sourceField = await firstVisibleAcrossFrames(page, (scope) => [
    scope.locator(
      'textarea[name="artclCn"], textarea#artclCn, textarea[name*="content" i], textarea[name*="cn" i]',
    ),
  ]);
  if (sourceField) {
    await assignHtml(sourceField, html);
    filledEditor = true;
  }

  if (!filledEditor) {
    const fallbackTextarea = await firstVisibleAcrossFrames(page, (scope) => [
      scope.getByLabel(/내용/),
      scope.locator("textarea"),
    ]);
    if (fallbackTextarea) {
      await assignHtml(fallbackTextarea, html);
      filledEditor = true;
    }
  }

  return filledEditor;
}

function namoSourceLocators(scope: Scope): Locator[] {
  return [
    scope.locator('textarea#NamoSE_editorhtml_editor'),
    scope.locator('textarea[id$="_editorhtml_editor" i]'),
    scope.locator('textarea.NamoSE_html_frame'),
    scope.locator('textarea[title*="HTML 편집 모드"]'),
  ];
}

function namoHtmlTabLocators(scope: Scope): Locator[] {
  return [
    scope.locator('#NamoSE_editorhtml, [id$="_editorhtml" i]'),
    scope.getByRole("tab", { name: /^HTML$/i }),
    scope.getByRole("button", { name: /^HTML$/i }),
    scope.getByRole("link", { name: /^HTML$/i }),
    scope.locator("li, a, button, span").filter({ hasText: /^HTML$/i }),
  ];
}

async function findVisibleNamoSource(page: Page): Promise<Locator | null> {
  for (const scope of searchScopes(page)) {
    for (const locator of namoSourceLocators(scope)) {
      if ((await locator.count().catch(() => 0)) === 0) continue;
      const candidate = locator.first();
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  return null;
}

export async function activateNamoHtmlMode(page: Page): Promise<boolean> {
  if (await findVisibleNamoSource(page)) return true;

  const htmlTab = await firstVisibleAcrossFrames(page, namoHtmlTabLocators);
  if (!htmlTab) return false;

  await htmlTab.scrollIntoViewIfNeeded().catch(() => undefined);
  await htmlTab.click({ timeout: ACTION_TIMEOUT_MS }).catch(async () => {
    await htmlTab.evaluate((element: HTMLElement | SVGElement) => {
      if (element instanceof HTMLElement) element.click();
    });
  });

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await findVisibleNamoSource(page)) return true;
    await page.waitForTimeout(200);
  }
  return false;
}

export async function fillKnouHtml(page: Page, html: string): Promise<boolean> {
  const namoReady = await activateNamoHtmlMode(page);
  if (!namoReady) return fillHtml(page, html);

  const source = await findVisibleNamoSource(page);
  if (!source) return false;

  await source.fill(html);
  await source.evaluate((element: HTMLElement | SVGElement) => {
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "End" }));
    element.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
  });
  return (await source.inputValue()) === html;
}

async function fillKnouPostForm(page: Page, title: string, html: string): Promise<{ titleFilled: boolean; htmlFilled: boolean }> {
  const [titleFilled, htmlFilled] = await Promise.all([
    fillTitle(page, title.trim()),
    fillKnouHtml(page, html),
  ]);
  return { titleFilled, htmlFilled };
}

async function selectTistoryCategory(page: Page, category: unknown): Promise<FormResult> {
  const wanted = String(category ?? "").trim();
  if (!wanted) return { attempted: false, ok: true };

  const nativeSelect = await firstVisibleAcrossFrames(page, (scope) => [
    scope.locator('select[name*="category" i]'),
    scope.locator("select#category"),
  ]);
  if (nativeSelect) {
    const selected = await nativeSelect.selectOption({ label: wanted }).catch(() => [] as string[]);
    return { attempted: true, ok: selected.length > 0 };
  }

  const categoryControl = await firstVisibleAcrossFrames(page, (scope) => [
    scope.locator("#category-btn"),
    scope.getByRole("button", { name: /카테고리/ }),
    scope.getByRole("combobox", { name: /카테고리/ }),
  ]);
  if (!categoryControl) return { attempted: true, ok: false };

  await categoryControl.click();
  const option = await firstVisibleAcrossFrames(page, (scope) => [
    scope.getByRole("option", { name: wanted, exact: true }),
    scope.getByRole("menuitem", { name: wanted, exact: true }),
    scope.locator("li, button, a").filter({ hasText: new RegExp(`^\\s*${escapeRegExp(wanted)}\\s*$`) }),
  ]);
  if (!option) return { attempted: true, ok: false };
  await option.click();
  return { attempted: true, ok: true };
}

function escapeRegExp(value: string): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function replaceTistoryTags(page: Page, tags: string[]): Promise<boolean> {
  const tagInput = await firstVisibleAcrossFrames(page, (scope) => [
    scope.locator('input[placeholder="태그입력"]'),
    scope.locator('input[placeholder*="태그"]'),
    scope.getByRole("textbox", { name: /태그/ }),
  ]);
  if (!tagInput) return tags.length === 0;

  const removeButtons = page.locator('.editor_tag .btn_delete, [aria-label*="태그 삭제"]');
  for (let index = (await removeButtons.count()) - 1; index >= 0; index -= 1) {
    await removeButtons.nth(index).click().catch(() => undefined);
  }

  for (const tag of tags) {
    await tagInput.fill(tag);
    await tagInput.press("Enter");
    await page.waitForTimeout(80);
  }
  return true;
}

export async function fillTistoryPostForm(page: Page, {
  title,
  html,
  tags = [],
  category = "",
}: { title?: string; html?: string; tags?: unknown; category?: unknown } = {}): Promise<FormResult> {
  const normalizedTags = normalizeTistoryTags(tags);
  const categoryResult = await selectTistoryCategory(page, category);
  if (categoryResult.attempted && !categoryResult.ok) {
    return {
      ok: false,
      code: "TISTORY_CATEGORY_NOT_FOUND",
      message: `티스토리 카테고리 '${category}' 항목을 찾지 못했습니다.`,
    };
  }

  const [titleFilled, htmlFilled] = await Promise.all([
    fillTitle(page, String(title ?? "").trim()),
    fillHtml(page, String(html ?? "")),
  ]);
  const tagsFilled = await replaceTistoryTags(page, normalizedTags);

  if (!titleFilled || !htmlFilled || !tagsFilled) {
    const missing = [
      !titleFilled && "제목",
      !htmlFilled && "본문",
      !tagsFilled && "태그",
    ].filter(Boolean).join("·");
    return {
      ok: false,
      code: "TISTORY_FORM_FIELD_NOT_FOUND",
      message: `티스토리 ${missing} 입력란을 찾지 못했습니다.`,
    };
  }

  return { ok: true, tags: normalizedTags };
}

function attachmentBuffer(attachment: any): { buffer: Buffer; mimeType: string } | null {
  const dataUrl = String(attachment?.dataUrl ?? "");
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!match) return null;
  const buffer = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  if (buffer.length === 0 || buffer.length > 15_000_000) return null;
  return { buffer, mimeType: match[1].toLowerCase() };
}

function imageExtension(mimeType: string): string {
  return ({
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
  } as Record<string, string>)[mimeType] ?? ".img";
}

async function tistoryEditorImageSources(page: Page): Promise<Set<string>> {
  const sources: string[] = [];
  for (const scope of searchScopes(page)) {
    const values = await scope.locator("img[src]").evaluateAll((images) => (
      images.flatMap((image) => [
        image.getAttribute("src"),
        image.getAttribute("data-src"),
        image.getAttribute("data-origin-src"),
        image.closest("[data-url]")?.getAttribute("data-url"),
      ]).filter(Boolean)
    )).catch(() => [] as (string | null | undefined)[]);
    sources.push(...(values as string[]));
  }
  return new Set(sources);
}

async function resetTistoryImageFocus(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => undefined);

  const editor = await firstVisibleAcrossFrames(page, (scope) => [
    scope.locator('[contenteditable="true"][role="textbox"]'),
    scope.locator(".ProseMirror, .toastui-editor-contents[contenteditable='true'], .cke_editable"),
    scope.locator('body[contenteditable="true"]'),
    scope.locator('[contenteditable="true"]'),
  ]);
  if (!editor) return;

  await editor.evaluate((element: HTMLElement | SVGElement) => {
    element.querySelectorAll("[data-mce-selected]").forEach((selected) => {
      selected.removeAttribute("data-mce-selected");
    });

    const selection = element.ownerDocument.defaultView?.getSelection();
    if (!selection) return;
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    if (element instanceof HTMLElement) element.focus();
  }).catch(() => undefined);
  await page.waitForTimeout(100);
}

async function findTistoryImageFileInput(page: Page): Promise<Locator | null> {
  for (const scope of searchScopes(page)) {
    const inputs = scope.locator('input[type="file"]');
    const candidates: Array<{ input: Locator; score: number }> = [];
    const count = Math.min(await inputs.count().catch(() => 0), 20);

    for (let index = 0; index < count; index += 1) {
      const input = inputs.nth(index);
      const details = await input.evaluate((element: HTMLElement | SVGElement) => {
        const marker = [
          element.id,
          element.getAttribute("name"),
          element.getAttribute("class"),
          element.getAttribute("aria-label"),
          element.getAttribute("data-testid"),
          element.parentElement?.getAttribute("class"),
          element.parentElement?.parentElement?.getAttribute("class"),
        ].filter(Boolean).join(" ").toLowerCase();
        const contextual = Boolean(element.closest(
          'figure, [data-ke-type="image"], [class*="image-toolbar" i], '
          + '[class*="image_control" i], [class*="image-control" i], '
          + '[class*="image-action" i]',
        )) || /(replace|change|modify|교체|변경|수정)/i.test(marker);
        const accept = String(element.getAttribute("accept") ?? "").toLowerCase();
        const score = (accept.includes("image") ? 30 : 0)
          + (element.hasAttribute("multiple") ? 20 : 0)
          + (/(attach|upload|file|첨부|업로드)/i.test(marker) ? 10 : 0);
        return {
          contextual,
          disabled: (element as HTMLInputElement).disabled,
          score,
        };
      }).catch(() => null);
      if (!details || details.contextual || details.disabled) continue;
      candidates.push({ input, score: details.score });
    }

    candidates.sort((left, right) => right.score - left.score);
    if (candidates.length > 0) return candidates[0].input;
  }
  return null;
}

async function uploadTistoryImages(page: Page, filePaths: string[]): Promise<Array<{ url: string; figureHtml: string }>> {
  await resetTistoryImageFocus(page);
  const before = await tistoryEditorImageSources(page);
  const fileInput = await findTistoryImageFileInput(page);
  const canUseFileInput = fileInput && (
    filePaths.length === 1
    || await fileInput.getAttribute("multiple").then((value) => value !== null).catch(() => false)
  );

  if (canUseFileInput && fileInput) {
    await fileInput.setInputFiles(filePaths);
  } else {
    const attachmentControl = await firstVisibleAcrossFrames(page, (scope) => [
      scope.getByRole("button", { name: /^첨부$/ }),
      scope.locator('[role="button"][aria-label="첨부"]'),
      scope.locator("#attach-layer-btn"),
    ]);
    if (!attachmentControl) return [];
    await attachmentControl.click();

    const imageMenuItem = await firstVisibleAcrossFrames(page, (scope) => [
      scope.locator("#attach-image"),
      scope.getByRole("menuitem", { name: /^사진$/ }),
      scope.getByText(/^사진$/, { exact: true }),
    ]);
    if (!imageMenuItem) return [];

    const chooserPromise = page.waitForEvent("filechooser", { timeout: 5_000 }).catch(() => null);
    await imageMenuItem.click();
    const chooser = await chooserPromise;
    if (!chooser || (filePaths.length > 1 && !chooser.isMultiple())) return [];
    await chooser.setFiles(filePaths);
  }

  const deadline = Date.now() + Math.min(60_000, 20_000 + (filePaths.length * 5_000));
  let latestUploads: Array<{ url: string; figureHtml: string }> = [];
  while (Date.now() < deadline) {
    await page.waitForTimeout(350);
    for (const scope of searchScopes(page)) {
      const uploaded = await scope.locator("img[src]").evaluateAll((images, previousSources) => {
        const previous = new Set(previousSources);
        const results: Array<{ url: string; figureHtml: string }> = [];
        const seen = new Set<string>();

        for (const image of images) {
          const candidates = [
            image.getAttribute("src"),
            image.getAttribute("data-src"),
            image.getAttribute("data-origin-src"),
            image.closest("[data-url]")?.getAttribute("data-url"),
          ].filter(Boolean) as string[];
          const url = candidates.find((candidate) => (
            !previous.has(candidate)
            && !candidate.startsWith("data:")
            && !candidate.startsWith("blob:")
            && !candidate.startsWith("growthlog-asset:")
          ));
          if (!url || seen.has(url)) continue;
          seen.add(url);

          const originalFigure = image.closest("figure");
          const clonedRoot = (originalFigure || image).cloneNode(true) as Element;
          const clonedImage = clonedRoot instanceof HTMLImageElement
            ? clonedRoot
            : clonedRoot.querySelector("img");
          if (clonedImage) clonedImage.setAttribute("src", url);
          results.push({
            url,
            figureHtml: clonedRoot.outerHTML,
          });
        }
        return results;
      }, [...before]).catch(() => null);
      if (Array.isArray(uploaded) && uploaded.length > latestUploads.length) latestUploads = uploaded;
      if (latestUploads.length >= filePaths.length) {
        await resetTistoryImageFocus(page);
        return latestUploads.slice(0, filePaths.length);
      }
    }
  }
  await resetTistoryImageFocus(page);
  return latestUploads;
}

function replaceTistoryImagePlaceholder(html: string, attachmentId: string, uploaded: { url: string; figureHtml: string }): string {
  const marker = `growthlog-asset://${attachmentId}`;
  const escapedMarker = escapeRegExp(marker);
  const figurePattern = new RegExp(
    `<figure[^>]*>\\s*<img([^>]*?)src=["']${escapedMarker}["']([^>]*)>`
      + `\\s*(?:<figcaption>([\\s\\S]*?)<\\/figcaption>)?\\s*<\\/figure>`,
    "i",
  );
  const match = figurePattern.exec(html);
  if (!match || !uploaded.figureHtml) return html.replaceAll(marker, uploaded.url);

  const caption = match[3] ?? "";
  let figureHtml = uploaded.figureHtml.replace(/\sdata-mce-selected=(["'])[^"']*\1/gi, "");
  if (/<figcaption>[\s\S]*?<\/figcaption>/i.test(figureHtml)) {
    figureHtml = figureHtml.replace(
      /<figcaption>[\s\S]*?<\/figcaption>/i,
      `<figcaption>${caption}</figcaption>`,
    );
  } else if (caption) {
    figureHtml = figureHtml.replace(/<\/figure>\s*$/i, `<figcaption>${caption}</figcaption></figure>`);
  }
  return html.replace(figurePattern, figureHtml);
}

export async function uploadTistoryAttachments(page: Page, html: string, attachments: any): Promise<FormResult> {
  if (!Array.isArray(attachments) || attachments.length === 0) return { ok: true, html };
  if (attachments.length > 30) {
    return { ok: false, code: "TOO_MANY_IMAGES", message: "글 하나에는 이미지 30개까지 올릴 수 있습니다." };
  }

  const tempDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "growth-log-tistory-"));
  let finalHtml = html;
  try {
    const prepared: Array<{ attachment: any; id: string; filePath: string }> = [];
    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index];
      const id = String(attachment?.id ?? "").trim();
      const decoded = attachmentBuffer(attachment);
      if (!id || !decoded) {
        return {
          ok: false,
          code: "INVALID_IMAGE",
          message: `${index + 1}번째 이미지 파일을 읽을 수 없습니다. PNG·JPG·GIF·WebP 형식을 사용해 주세요.`,
        };
      }

      const filePath = path.join(tempDirectory, `${String(index + 1).padStart(2, "0")}${imageExtension(decoded.mimeType)}`);
      await fs.promises.writeFile(filePath, decoded.buffer, { mode: 0o600 });
      prepared.push({ attachment, id, filePath });
    }

    const uploaded = await uploadTistoryImages(page, prepared.map((item) => item.filePath));
    if (uploaded.length !== prepared.length) {
      const next = prepared[uploaded.length];
      return {
        ok: false,
        code: "TISTORY_IMAGE_UPLOAD_FAILED",
        message: `'${String(next?.attachment?.name || "이미지")}'을 포함한 업로드 결과를 모두 확인하지 못했습니다. (${uploaded.length}/${prepared.length})`,
      };
    }

    for (let index = 0; index < prepared.length; index += 1) {
      finalHtml = replaceTistoryImagePlaceholder(finalHtml, prepared[index].id, uploaded[index]);
    }
  } finally {
    await fs.promises.rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
  }

  if (finalHtml.includes("growthlog-asset://")) {
    return {
      ok: false,
      code: "TISTORY_IMAGE_REFERENCE_MISSING",
      message: "본문의 일부 이미지와 ZIP 파일을 연결하지 못했습니다.",
    };
  }
  return { ok: true, html: finalHtml };
}

async function clickTistoryCompletion(page: Page): Promise<boolean> {
  const control = await firstVisible([
    page.getByRole("button", { name: /^완료$/ }),
    page.locator("button").filter({ hasText: /^완료$/ }),
  ]);
  if (!control) return false;
  await control.click();
  await page.waitForTimeout(250);
  return true;
}

export async function saveTistoryPostForm(page: Page, mode = "draft"): Promise<FormResult> {
  if (!(await clickTistoryCompletion(page))) {
    return {
      ok: false,
      code: "TISTORY_COMPLETE_NOT_FOUND",
      message: "티스토리 완료 버튼을 찾지 못했습니다.",
    };
  }

  if (mode === "draft") {
    const privateChoice = await firstVisible([
      page.getByRole("radio", { name: /^비공개$/ }),
      page.getByLabel(/^비공개$/),
      page.locator('input[type="radio"][value*="private" i]'),
    ]);
    if (!privateChoice) {
      return {
        ok: false,
        code: "TISTORY_PRIVATE_OPTION_NOT_FOUND",
        message: "임시저장을 위한 비공개 선택 항목을 찾지 못했습니다.",
      };
    }
    await privateChoice.check().catch(() => privateChoice.click());
  }

  const finalAction = await firstVisible([
    mode === "draft"
      ? page.getByRole("button", { name: /^(비공개\s*)?(저장|발행)$/ })
      : page.getByRole("button", { name: /^공개\s*발행$/ }),
    page.locator("button").filter({
      hasText: mode === "draft" ? /^(비공개\s*)?(저장|발행)$/ : /^공개\s*발행$/,
    }),
  ]);
  if (!finalAction) {
    return {
      ok: false,
      code: "TISTORY_SAVE_ACTION_NOT_FOUND",
      message: mode === "draft"
        ? "티스토리 비공개 저장 버튼을 찾지 못했습니다."
        : "티스토리 공개 발행 버튼을 찾지 못했습니다.",
    };
  }

  await finalAction.click();
  await page.waitForLoadState("domcontentloaded", { timeout: 7_000 }).catch(() => undefined);
  await page.waitForTimeout(500);
  return {
    ok: true,
    code: mode === "draft" ? "TISTORY_PRIVATE_DRAFT_SAVED" : "TISTORY_PUBLIC_POST_SAVED",
    message: mode === "draft"
      ? "티스토리 글을 비공개로 임시저장했습니다."
      : "티스토리 공개 글 수정을 저장했습니다.",
  };
}

// 지역대학 글쓰기 폼의 필수 "분류(지역) 선택" 드롭다운(#bbsClSeq1 / select.sel-type)을 찾습니다.
async function findRegionalCategorySelect(page: Page): Promise<Locator | null> {
  for (const scope of searchScopes(page)) {
    for (const locator of [
      scope.locator("#bbsClSeq1"),
      scope.locator('select[onchange*="jf_selectCl"]'),
      scope.locator("select.sel-type"),
    ]) {
      if ((await locator.count().catch(() => 0)) > 0) return locator.first();
    }
  }
  return null;
}

// 게시판 이름("○○지역대학")에 맞는 지역 옵션을 골라 분류 드롭다운을 선택합니다.
// onchange(jf_selectCl) 핸들러가 실행되도록 네이티브 change 이벤트를 발생시킵니다.
export async function selectRegionalCategory(page: Page, boardName: unknown): Promise<FormResult> {
  const region = String(boardName ?? "").replace(/\s*지역대학\s*$/, "").trim();
  if (!region) return { attempted: false, ok: false };

  const select = await findRegionalCategorySelect(page);
  if (!select) return { attempted: false, ok: false };

  const matchedValue = await select.evaluate((element, target) => {
    const normalize = (value: string) => value.replace(/\s+/g, "").trim();
    const wanted = normalize(target);
    const selectElement = element as HTMLSelectElement;
    const options = Array.from(selectElement.options);
    const option = options.find((item) => normalize(item.textContent ?? "") === wanted)
      ?? options.find((item) => {
        const label = normalize(item.textContent ?? "");
        return label && (label.includes(wanted) || wanted.includes(label));
      });
    if (!option || !option.value) return "";
    selectElement.value = option.value;
    selectElement.dispatchEvent(new Event("change", { bubbles: true }));
    return option.value;
  }, region).catch(() => "");

  if (!matchedValue) return { attempted: true, ok: false, region };

  await page.waitForTimeout(700); // jf_selectCl의 하위 분류 로딩 등 후속 처리를 기다립니다.
  return { attempted: true, ok: true, region };
}

async function hasCaptcha(page: Page): Promise<boolean> {
  for (const scope of searchScopes(page)) {
    const count = await scope.locator(
      'iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], '
      + ".g-recaptcha, .h-captcha, [data-sitekey]",
    ).count().catch(() => 0);
    if (count > 0) return true;
  }
  return false;
}

function finalSubmitLocators(scope: Scope, mode: string): Locator[] {
  const buttonName = mode === "modify"
    ? /^(저장|수정|변경|수정\s*완료|등록|저장하기)$/
    : /^(등록|저장|게시|작성\s*완료|등록하기|게시하기)$/;

  return [
    scope.getByRole("button", { name: buttonName }),
    scope.getByRole("link", { name: buttonName }),
    scope.locator('button[type="submit"]').filter({ hasText: buttonName }),
    scope.locator(
      mode === "modify"
        ? 'input[type="submit"][value*="저장"], input[type="submit"][value*="수정"], '
          + 'input[type="button"][value*="저장"], input[type="button"][value*="수정"]'
        : 'input[type="submit"][value*="등록"], input[type="submit"][value*="게시"], '
          + 'input[type="button"][value*="등록"], input[type="button"][value*="게시"]',
    ),
  ];
}

export async function submitPostForm(page: Page, mode: string): Promise<FormResult> {
  if (await hasCaptcha(page)) {
    return {
      ok: false,
      code: "CAPTCHA_REQUIRED",
      message: "방송대에서 CAPTCHA 확인이 필요합니다. 자동화 브라우저에서 직접 완료한 뒤 다시 시도해 주세요.",
    };
  }

  const submitControl = await firstVisibleAcrossFrames(page, (scope) => finalSubmitLocators(scope, mode));
  if (!submitControl) {
    return {
      ok: false,
      code: "SUBMIT_CONTROL_NOT_FOUND",
      message: mode === "modify"
        ? "최종 저장 버튼을 찾지 못했습니다. 열린 수정 화면에서 직접 저장해 주세요."
        : "최종 등록 버튼을 찾지 못했습니다. 열린 글쓰기 화면에서 직접 등록해 주세요.",
    };
  }

  const initialUrl = page.url();
  let dialogMessage = "";
  let resolveSuccessDialog: (value: boolean) => void = () => undefined;
  const successDialog = new Promise<boolean>((resolve) => {
    resolveSuccessDialog = resolve;
  });
  const navigation = page.waitForURL((url) => url.href !== initialUrl, {
    timeout: NAVIGATION_TIMEOUT_MS,
  }).then(() => true).catch(() => false);
  const acceptDialog = async (dialog: Dialog) => {
    dialogMessage = dialog.message();
    const success = dialog.type() === "alert"
      && POST_COMPLETION_PATTERN.test(dialogMessage);
    await dialog.accept();
    if (success) resolveSuccessDialog(true);
  };
  page.on("dialog", acceptDialog);

  try {
    await submitControl.scrollIntoViewIfNeeded().catch(() => undefined);
    await submitControl.click({ timeout: ACTION_TIMEOUT_MS }).catch(async () => {
      await submitControl.evaluate((element: HTMLElement | SVGElement) => {
        if (element instanceof HTMLElement) element.click();
      });
    });

    const confirmControl = await firstVisibleAcrossFrames(page, (scope) => [
      scope.getByRole("dialog").getByRole("button", { name: /^(확인|예|등록|저장)$/ }),
    ]);
    if (confirmControl) await confirmControl.click();

    const completionText = page.waitForFunction((patternSource) => {
      const text = document.body?.innerText ?? "";
      return new RegExp(patternSource).test(text);
    }, POST_COMPLETION_PATTERN.source, {
      timeout: NAVIGATION_TIMEOUT_MS,
    }).then(() => true).catch(() => false);
    const confirmed = await Promise.race([navigation, completionText, successDialog]);
    if (!confirmed) {
      return {
        ok: false,
        code: "SUBMIT_NOT_CONFIRMED",
        message: "최종 버튼을 눌렀지만 방송대의 게시 완료를 확인하지 못했습니다. 열린 브라우저에서 상태를 확인해 주세요.",
      };
    }
    await page.waitForTimeout(500);
  } finally {
    page.off("dialog", acceptDialog);
  }

  return {
    ok: true,
    code: "FINAL_SUBMIT_CLICKED",
    message: mode === "modify"
      ? "방송대의 최종 저장 버튼을 자동으로 눌렀습니다."
      : "방송대의 최종 등록 버튼을 자동으로 눌렀습니다.",
    dialogMessage,
  };
}

// ─── 운영 Google Sheets 기록 (회차별 게시 날짜/제목/링크 write-back) ────────────
// GOOGLE_SERVICE_ACCOUNT_KEY(서비스 계정 JSON 원문 또는 파일 경로)가 설정된 경우에만 동작합니다.
// 새 npm 의존성 없이 Node 내장 crypto로 서비스 계정 JWT를 서명해 액세스 토큰을 발급합니다.

const SHEETS_SPREADSHEET_ID = process.env.GROWTH_LOG_SHEETS_ID ?? "1gPZe8cwqKbMU2PBXg2V3mYLLT3MkhdkDZpTXcGqOtE0";
const SHEETS_TAB_CONFIG: Record<string, { gid: string; headerRow: number }> = {
  department: { gid: "392712092", headerRow: 7 },
  regional: { gid: "1190277445", headerRow: 6 },
};

function base64url(input: crypto.BinaryLike): string {
  return Buffer.from(input as any).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function columnLetter(zeroBasedIndex: number): string {
  let index = zeroBasedIndex;
  let letter = "";
  do {
    letter = String.fromCharCode(65 + (index % 26)) + letter;
    index = Math.floor(index / 26) - 1;
  } while (index >= 0);
  return letter;
}

function a1Cell(sheetTitle: string, oneBasedRow: number, zeroBasedCol: number): string {
  return `'${String(sheetTitle).replace(/'/g, "''")}'!${columnLetter(zeroBasedCol)}${oneBasedRow}`;
}

// 서비스 계정 키를 환경변수(JSON 원문) 또는 파일 경로에서 읽습니다. 없으면 null.
function readServiceAccount(): any {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY?.trim();
  if (!raw) return null;
  try {
    const text = raw.startsWith("{") ? raw : fs.readFileSync(raw, "utf8");
    const parsed = JSON.parse(text);
    if (parsed.client_email && parsed.private_key) return parsed;
  } catch {
    // 키 형식이 잘못된 경우 시트 기록만 조용히 건너뜁니다.
  }
  return null;
}

let cachedSheetsToken = { value: "", expiresAt: 0 };

async function getSheetsAccessToken(serviceAccount: any): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedSheetsToken.value && cachedSheetsToken.expiresAt > now + 60) return cachedSheetsToken.value;

  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${claim}`);
  const signature = base64url(signer.sign(serviceAccount.private_key));
  const assertion = `${header}.${claim}.${signature}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!response.ok) throw new Error(`토큰 발급 실패 (${response.status})`);
  const data = await response.json();
  cachedSheetsToken = { value: data.access_token, expiresAt: now + Number(data.expires_in ?? 3600) };
  return cachedSheetsToken.value;
}

async function sheetsFetch(token: string, pathAndQuery: string, init?: RequestInit): Promise<any> {
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEETS_SPREADSHEET_ID}${pathAndQuery}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`Sheets API ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

export function resolvePostingRoundColumns(headers: string[], round: number): { names: string[]; indexes: number[]; insertAt: number } {
  const names = [`${round}차 게시`, `${round}차 게시 제목`, `${round}차 링크`, `${round}차 소개`];
  const indexes = names.map((name) => headers.indexOf(name));
  const existingCount = indexes.filter((index) => index >= 0).length;
  if (existingCount === 0) {
    return { names, indexes: names.map((_, offset) => headers.length + offset), insertAt: headers.length };
  }
  if (existingCount !== names.length) {
    const missing = names.filter((_, index) => indexes[index] < 0).join("·");
    throw new Error(`${round}차 열 구조가 불완전합니다. 누락: ${missing}`);
  }
  return { names, indexes, insertAt: -1 };
}

// 회차 열이 없으면 게시·제목·링크·소개 열을 시트 끝에 함께 생성합니다.
async function recordRoundCreation({ boardId, title, postUrl, round }: { boardId: unknown; title: string; postUrl: string; round: number }): Promise<FormResult> {
  const serviceAccount = readServiceAccount();
  if (!serviceAccount) return { ok: false, skipped: true, message: "" };

  const match = /^(department|regional)-(.+)$/.exec(String(boardId ?? "").trim());
  if (!match) return { ok: false, message: "시트 기록 생략: 게시판 ID를 해석할 수 없습니다." };
  const [, kind, boardNo] = match;
  const config = SHEETS_TAB_CONFIG[kind];

  const token = await getSheetsAccessToken(serviceAccount);
  const meta = await sheetsFetch(token, "?fields=sheets(properties(sheetId,title))");
  const sheet = (meta.sheets ?? []).find((item: any) => String(item.properties.sheetId) === config.gid);
  if (!sheet) return { ok: false, message: "시트 기록 실패: 대상 시트 탭을 찾지 못했습니다." };
  const sheetTitle = sheet.properties.title;

  const read = await sheetsFetch(token, `/values/${encodeURIComponent(`'${sheetTitle}'!A${config.headerRow}:ZZ`)}`);
  const rows = read.values ?? [];
  const headers = (rows[0] ?? []).map((cell: unknown) => String(cell ?? "").trim());
  const numberCol = headers.indexOf("번호");
  if (numberCol < 0) return { ok: false, message: "시트 기록 실패: 번호 열을 찾지 못했습니다." };

  const rowOffset = rows.slice(1).findIndex((row: any[]) => String(row[numberCol] ?? "").trim() === boardNo.trim());
  if (rowOffset < 0) return { ok: false, message: `시트 기록 실패: 번호 ${boardNo} 행을 찾지 못했습니다.` };
  const targetRow = config.headerRow + 1 + rowOffset;

  let columns: { names: string[]; indexes: number[]; insertAt: number };
  try {
    columns = resolvePostingRoundColumns(headers, round);
  } catch (error: any) {
    return { ok: false, message: `시트 기록 실패: ${error.message}` };
  }
  if (columns.insertAt >= 0) {
    await sheetsFetch(token, ":batchUpdate", {
      method: "POST",
      body: JSON.stringify({
        requests: [{
          insertDimension: {
            range: {
              sheetId: sheet.properties.sheetId,
              dimension: "COLUMNS",
              startIndex: columns.insertAt,
              endIndex: columns.insertAt + columns.names.length,
            },
            inheritFromBefore: true,
          },
        }],
      }),
    });
  }

  const [postCol, titleCol, linkCol] = columns.indexes;
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const data = [
    { range: a1Cell(sheetTitle, targetRow, postCol), values: [[today]] },
    { range: a1Cell(sheetTitle, targetRow, titleCol), values: [[title]] },
    { range: a1Cell(sheetTitle, targetRow, linkCol), values: [[postUrl]] },
  ];
  if (columns.insertAt >= 0) {
    data.push({
      range: `${a1Cell(sheetTitle, config.headerRow, columns.insertAt)}:${columnLetter(columns.insertAt + columns.names.length - 1)}${config.headerRow}`,
      values: [columns.names],
    });
  }

  await sheetsFetch(token, "/values:batchUpdate", {
    method: "POST",
    body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
  });
  return { ok: true, message: `운영 시트에 ${round}차 게시·제목·링크를 기록했습니다.` };
}

async function openLogin(): Promise<FormResult> {
  const page = await getWorkPage();
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  await surfaceForUser(page, true);
  return {
    ok: true,
    status: "login-opened",
    message: "Electron 자동화 브라우저를 열었습니다. 방송대 로그인을 완료한 뒤 창을 닫아도 됩니다.",
  };
}

async function openTistoryLogin(body: any = {}): Promise<FormResult> {
  const manageUrl = normalizeTistoryManageUrl(body.blogUrl);
  const targetUrl = manageUrl || TISTORY_LOGIN_URL;
  const page = await getWorkPage();
  await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
  await surfaceForUser(page, true);
  return {
    ok: true,
    status: "tistory-login-opened",
    message: manageUrl
      ? "티스토리 관리 화면을 열었습니다. 로그인이 필요하면 로그인한 뒤 창을 그대로 두세요."
      : "티스토리 로그인 화면을 열었습니다. 로그인한 뒤 창을 그대로 두세요.",
    pageUrl: page.url(),
  };
}

function validateTistoryPostInput(body: any, { requirePostUrl = false }: { requirePostUrl?: boolean } = {}): { ok: true; title: string; html: string } | { ok: false; code: string; message: string } {
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const html = typeof body?.html === "string" ? body.html : "";
  if (!title || title.length > 500) {
    return { ok: false, code: "INVALID_TITLE", message: "500자 이하의 글 제목을 입력해 주세요." };
  }
  if (!html.trim() || html.length > 1_500_000) {
    return { ok: false, code: "INVALID_HTML", message: "본문 HTML을 입력해 주세요." };
  }
  if (requirePostUrl && !tistoryUrl(body?.postUrl)) {
    return { ok: false, code: "INVALID_TISTORY_POST_URL", message: "티스토리 게시글 또는 수정 URL을 입력해 주세요." };
  }
  return { ok: true, title, html };
}

function isTistoryLoginPage(page: Page): boolean {
  const url = page.url();
  return /accounts\.kakao\.com|\/auth\/login|\/login(?:[/?#]|$)/i.test(url);
}

async function prepareTistoryDraft(body: any): Promise<HttpResult> {
  const input = validateTistoryPostInput(body);
  if (!input.ok) return { status: 400, body: input };

  const manageUrl = normalizeTistoryManageUrl(body?.blogUrl);
  if (!manageUrl) {
    return {
      status: 400,
      body: {
        ok: false,
        code: "INVALID_TISTORY_BLOG_URL",
        message: "예: https://블로그이름.tistory.com 형식의 티스토리 주소를 입력해 주세요.",
      },
    };
  }

  await prepareBrowserInBackground();
  const page = await getWorkPage();
  await page.goto(manageUrl, { waitUntil: "domcontentloaded" });
  if (isTistoryLoginPage(page)) {
    await surfaceForUser(page);
    return {
      status: 409,
      body: {
        ok: false,
        code: "TISTORY_LOGIN_REQUIRED",
        message: "티스토리 로그인이 필요합니다. 열린 자동화 브라우저에서 로그인한 뒤 다시 실행해 주세요.",
        pageUrl: page.url(),
      },
    };
  }

  const formReady = await waitForPostForm(page, 10_000);
  if (!formReady) {
    await surfaceForUser(page);
    return {
      status: 422,
      body: {
        ok: false,
        code: "TISTORY_EDITOR_NOT_FOUND",
        message: "티스토리 글쓰기 화면을 찾지 못했습니다. 열린 자동화 브라우저에서 상태를 확인해 주세요.",
        pageUrl: page.url(),
      },
    };
  }

  const filled = await fillTistoryPostForm(page, {
    title: input.title,
    html: input.html,
    tags: body.tags,
    category: body.category,
  });
  if (!filled.ok) {
    await surfaceForUser(page);
    return { status: 422, body: { ...filled, pageUrl: page.url() } };
  }

  const uploaded = await uploadTistoryAttachments(page, input.html, body.attachments);
  if (!uploaded.ok || !(await fillHtml(page, uploaded.html!))) {
    await surfaceForUser(page);
    return {
      status: 422,
      body: {
        ...(uploaded.ok
          ? { ok: false, code: "TISTORY_EDITOR_NOT_FOUND", message: "이미지를 반영한 본문을 다시 입력하지 못했습니다." }
          : uploaded),
        pageUrl: page.url(),
      },
    };
  }

  const saved = await saveTistoryPostForm(page, "draft");
  if (!saved.ok) {
    await surfaceForUser(page);
    return { status: 422, body: { ...saved, pageUrl: page.url() } };
  }
  return {
    status: 200,
    body: {
      ...saved,
      ok: true,
      title: input.title,
      tags: filled.tags,
      pageUrl: page.url(),
    },
  };
}

async function prepareTistoryDraftBatch(body: any): Promise<HttpResult> {
  const items = Array.isArray(body?.items) ? body.items : [];
  if (items.length === 0 || items.length > 30) {
    return {
      status: 400,
      body: {
        ok: false,
        code: "INVALID_BATCH",
        message: "한 번에 1개 이상 30개 이하의 글을 선택해 주세요.",
      },
    };
  }

  const results: any[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index] ?? {};
    const result = await prepareTistoryDraft({
      ...item,
      blogUrl: item.blogUrl || body.blogUrl,
      category: item.category || body.category,
    });
    results.push({
      index,
      title: String(item.title ?? ""),
      status: result.status,
      ...result.body,
    });
    if (result.body?.code === "TISTORY_LOGIN_REQUIRED") break;
  }

  const savedCount = results.filter((result) => result.ok).length;
  return {
    status: savedCount === items.length ? 200 : 422,
    body: {
      ok: savedCount === items.length,
      status: "batch-complete",
      message: `${items.length}개 중 ${savedCount}개를 티스토리에 임시저장했습니다.`,
      savedCount,
      requestedCount: items.length,
      results,
    },
  };
}

async function prepareTistoryModification(body: any): Promise<HttpResult> {
  const input = validateTistoryPostInput(body, { requirePostUrl: true });
  if (!input.ok) return { status: 400, body: input };

  const postUrl = tistoryUrl(body.postUrl)!;
  await prepareBrowserInBackground();
  const page = await getWorkPage();
  await page.goto(postUrl.href, { waitUntil: "domcontentloaded" });
  if (isTistoryLoginPage(page)) {
    await surfaceForUser(page);
    return {
      status: 409,
      body: {
        ok: false,
        code: "TISTORY_LOGIN_REQUIRED",
        message: "티스토리 로그인이 필요합니다. 열린 자동화 브라우저에서 로그인한 뒤 다시 실행해 주세요.",
        pageUrl: page.url(),
      },
    };
  }

  const directEditor = /\/manage\/(?:newpost|post\/\d+)/.test(page.url());
  if (!directEditor) {
    const editControl = await firstVisible([
      page.getByRole("link", { name: /수정/ }),
      page.getByRole("button", { name: /수정/ }),
      page.locator('a[href*="/manage/post/"]'),
    ]);
    if (!editControl) {
      await surfaceForUser(page);
      return {
        status: 422,
        body: {
          ok: false,
          code: "TISTORY_EDIT_CONTROL_NOT_FOUND",
          message: "티스토리 수정 버튼을 찾지 못했습니다.",
          pageUrl: page.url(),
        },
      };
    }
    await editControl.click();
    await page.waitForLoadState("domcontentloaded", { timeout: 7_000 }).catch(() => undefined);
  }

  if (!(await waitForPostForm(page, 10_000))) {
    await surfaceForUser(page);
    return {
      status: 422,
      body: {
        ok: false,
        code: "TISTORY_EDITOR_NOT_FOUND",
        message: "티스토리 수정 화면을 찾지 못했습니다.",
        pageUrl: page.url(),
      },
    };
  }

  const filled = await fillTistoryPostForm(page, {
    title: input.title,
    html: input.html,
    tags: body.tags,
    category: body.category,
  });
  if (!filled.ok) {
    await surfaceForUser(page);
    return { status: 422, body: { ...filled, pageUrl: page.url() } };
  }

  const uploaded = await uploadTistoryAttachments(page, input.html, body.attachments);
  if (!uploaded.ok || !(await fillHtml(page, uploaded.html!))) {
    await surfaceForUser(page);
    return {
      status: 422,
      body: {
        ...(uploaded.ok
          ? { ok: false, code: "TISTORY_EDITOR_NOT_FOUND", message: "이미지를 반영한 본문을 다시 입력하지 못했습니다." }
          : uploaded),
        pageUrl: page.url(),
      },
    };
  }

  if (body.confirmPublicSave === true) {
    const saved = await saveTistoryPostForm(page, "publish");
    if (!saved.ok) {
      await surfaceForUser(page);
      return { status: 422, body: { ...saved, pageUrl: page.url() } };
    }
    return {
      status: 200,
      body: { ...saved, ok: true, title: input.title, tags: filled.tags, pageUrl: page.url() },
    };
  }

  await surfaceForUser(page);
  return {
    status: 200,
    body: {
      ok: true,
      status: "ready-for-review",
      message: "티스토리 수정 화면에 내용을 입력했습니다. 확인 후 완료 버튼을 눌러 주세요.",
      title: input.title,
      tags: filled.tags,
      pageUrl: page.url(),
    },
  };
}

async function prepareModification(body: any): Promise<HttpResult> {
  const { boardName, postUrl, title, html, confirmFinalSubmit } = body ?? {};

  if (!isKnouUrl(postUrl)) {
    return { status: 400, body: { ok: false, code: "INVALID_POST_URL", message: "방송대 게시글 URL만 열 수 있습니다." } };
  }
  if (typeof title !== "string" || title.trim().length === 0 || title.length > 500) {
    return { status: 400, body: { ok: false, code: "INVALID_TITLE", message: "500자 이하의 게시글 제목을 입력해 주세요." } };
  }
  if (typeof html !== "string" || html.trim().length === 0 || html.length > 600_000) {
    return { status: 400, body: { ok: false, code: "INVALID_HTML", message: "게시할 HTML 내용을 입력해 주세요." } };
  }

  await prepareBrowserInBackground();
  const page = await getWorkPage();
  await page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });

  if (page.url().includes("/error.html") || /\/login(?:[/?#]|$)/i.test(page.url())) {
    await surfaceForUser(page);
    return {
      status: 409,
      body: {
        ok: false,
        code: "LOGIN_REQUIRED",
        message: "방송대 로그인이 필요합니다. 자동화 브라우저에서 로그인한 뒤 다시 시도해 주세요.",
      },
    };
  }

  const editPage = await openEditForm(page);
  if (!editPage) {
    await surfaceForUser(page);
    return {
      status: 422,
      body: {
        ok: false,
        code: "EDIT_CONTROL_NOT_FOUND",
        message: "수정 버튼을 찾지 못했습니다. 자동화 브라우저에서 로그인 상태와 수정 권한을 확인해 주세요.",
        pageUrl: page.url(),
      },
    };
  }

  const { titleFilled, htmlFilled } = await fillKnouPostForm(editPage, title, html);

  if (!titleFilled || !htmlFilled) {
    await surfaceForUser(editPage);
    return {
      status: 422,
      body: {
        ok: false,
        code: "FORM_FIELD_NOT_FOUND",
        message: `${!titleFilled ? "제목" : "HTML 내용"} 입력란을 찾지 못했습니다. 열린 수정 화면은 그대로 두었습니다.`,
        pageUrl: editPage.url(),
      },
    };
  }

  if (confirmFinalSubmit === true) {
    const submitted = await submitPostForm(editPage, "modify");
    if (!submitted.ok) {
      await surfaceForUser(editPage);
      return {
        status: 422,
        body: {
          ...submitted,
          pageUrl: editPage.url(),
        },
      };
    }

    return {
      status: 200,
      body: {
        ok: true,
        status: "submitted",
        message: `${String(boardName || "선택한 게시판")} 게시글의 수정 내용을 저장했습니다.`,
        pageUrl: editPage.url(),
      },
    };
  }

  await surfaceForUser(editPage);
  return {
    status: 200,
    body: {
      ok: true,
      status: "ready-for-review",
      message: `${String(boardName || "선택한 게시판")} 수정 화면에 제목과 HTML을 입력했습니다. 내용을 검토한 뒤 방송대의 최종 저장 버튼은 직접 눌러 주세요.`,
      pageUrl: editPage.url(),
    },
  };
}

async function autoLogin(body: any): Promise<HttpResult> {
  const { username, password } = body ?? {};

  if (typeof username !== "string" || username.trim().length === 0 || username.length > 200) {
    return { status: 400, body: { ok: false, code: "INVALID_USERNAME", message: "아이디를 입력해 주세요." } };
  }
  if (typeof password !== "string" || password.length === 0 || password.length > 200) {
    return { status: 400, body: { ok: false, code: "INVALID_PASSWORD", message: "비밀번호를 입력해 주세요." } };
  }

  await prepareBrowserInBackground();
  const page = await getWorkPage();
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

  const usernameField = page.locator("#username");
  const passwordField = page.locator("#password");
  if ((await usernameField.count()) === 0 || (await passwordField.count()) === 0) {
    await surfaceForUser(page);
    return {
      status: 422,
      body: { ok: false, code: "LOGIN_FORM_NOT_FOUND", message: "로그인 입력란을 찾지 못했습니다. 자동화 브라우저에서 직접 로그인해 주세요." },
    };
  }

  await usernameField.fill(username);
  await passwordField.fill(password);

  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => undefined),
    page.getByRole("button", { name: "로그인" }).click(),
  ]);
  await page.waitForTimeout(800);

  if (/\/login(?:[/?#]|$)/i.test(page.url())) {
    return {
      status: 401,
      body: { ok: false, code: "LOGIN_FAILED", message: "로그인에 실패했습니다. 아이디와 비밀번호를 확인해 주세요." },
    };
  }

  return {
    status: 200,
    body: { ok: true, status: "logged-in", message: "방송대 로그인이 완료되었습니다." },
  };
}

async function prepareCreation(body: any): Promise<HttpResult> {
  const { boardId, boardName, boardUrl, title, html, round, confirmFinalSubmit } = body ?? {};
  const postRound = Number(round);

  if (!isKnouUrl(boardUrl)) {
    return { status: 400, body: { ok: false, code: "INVALID_BOARD_URL", message: "방송대 게시판 URL만 열 수 있습니다." } };
  }
  if (typeof title !== "string" || title.trim().length === 0 || title.length > 500) {
    return { status: 400, body: { ok: false, code: "INVALID_TITLE", message: "500자 이하의 게시글 제목을 입력해 주세요." } };
  }
  if (typeof html !== "string" || html.trim().length === 0 || html.length > 600_000) {
    return { status: 400, body: { ok: false, code: "INVALID_HTML", message: "게시할 HTML 내용을 입력해 주세요." } };
  }
  if (!Number.isInteger(postRound) || postRound < 1) {
    return { status: 400, body: { ok: false, code: "INVALID_ROUND", message: "게시 회차는 1 이상의 정수여야 합니다." } };
  }

  await prepareBrowserInBackground();
  const page = await getWorkPage();
  await page.goto(boardUrl, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });

  if (page.url().includes("/error.html") || /\/login(?:[/?#]|$)/i.test(page.url())) {
    await surfaceForUser(page);
    return {
      status: 409,
      body: {
        ok: false,
        code: "LOGIN_REQUIRED",
        message: "방송대 로그인이 필요합니다. 자동화 브라우저에서 로그인한 뒤 다시 시도해 주세요.",
      },
    };
  }

  const writePage = await openWriteForm(page);
  if (!writePage) {
    await surfaceForUser(page);
    return {
      status: 422,
      body: {
        ok: false,
        code: "WRITE_CONTROL_NOT_FOUND",
        message: "글쓰기 버튼을 찾지 못했습니다. 자동화 브라우저에서 로그인 상태와 작성 권한을 확인해 주세요.",
        pageUrl: page.url(),
      },
    };
  }

  // 지역대학 게시판은 글쓰기 전에 필수 "분류(지역)"를 선택해야 합니다.
  // 분류 선택이 에디터를 갱신할 수 있으므로 제목·HTML을 채우기 전에 먼저 처리합니다.
  if (String(boardId ?? "").startsWith("regional-")) {
    const category = await selectRegionalCategory(writePage, boardName);
    if (category.attempted && category.ok === false) {
      await surfaceForUser(writePage);
      return {
        status: 422,
        body: {
          ok: false,
          code: "CATEGORY_NOT_MATCHED",
          message: `지역 분류에서 '${category.region}'에 해당하는 항목을 찾지 못했습니다. 자동화 브라우저에서 분류를 직접 선택한 뒤 다시 시도해 주세요.`,
          pageUrl: writePage.url(),
        },
      };
    }
  }

  const { titleFilled, htmlFilled } = await fillKnouPostForm(writePage, title, html);

  if (!titleFilled || !htmlFilled) {
    await surfaceForUser(writePage);
    return {
      status: 422,
      body: {
        ok: false,
        code: "FORM_FIELD_NOT_FOUND",
        message: `${!titleFilled ? "제목" : "HTML 내용"} 입력란을 찾지 못했습니다. 열린 글쓰기 화면은 그대로 두었습니다.`,
        pageUrl: writePage.url(),
      },
    };
  }

  if (confirmFinalSubmit === true) {
    const submitted = await submitPostForm(writePage, "create");
    if (!submitted.ok) {
      await surfaceForUser(writePage);
      return {
        status: 422,
        body: {
          ...submitted,
          pageUrl: writePage.url(),
        },
      };
    }

    // 게시가 실제로 등록된 뒤에만 운영 시트의 해당 회차에 기록합니다.
    // 시트 기록 실패는 이미 성공한 게시를 무효화하지 않도록 안내 문구로만 반영합니다.
    let sheetNote = "";
    const recorded = await recordRoundCreation({
      boardId,
      title: title.trim(),
      postUrl: writePage.url(),
      round: postRound,
    }).catch((error: any) => ({ ok: false, message: `시트 기록 오류: ${error?.message ?? error}` } as FormResult));
    if (recorded.message) sheetNote = ` ${recorded.message}`;

    return {
      status: 200,
      body: {
        ok: true,
        status: "submitted",
        message: `${String(boardName || "선택한 게시판")} 게시글을 등록했습니다.${sheetNote}`,
        pageUrl: writePage.url(),
      },
    };
  }

  await surfaceForUser(writePage);
  return {
    status: 200,
    body: {
      ok: true,
      status: "ready-for-review",
      message: `${String(boardName || "선택한 게시판")} 글쓰기 화면에 제목과 HTML을 입력했습니다. 내용을 검토한 뒤 방송대의 최종 등록 버튼은 직접 눌러 주세요.`,
      pageUrl: writePage.url(),
    },
  };
}

async function respondWithBrowserTask(response: http.ServerResponse, origin: string, task: () => any): Promise<void> {
  const result = await browserTaskQueue.run(task);
  const isHttpResult = result
    && Number.isInteger(result.status)
    && Object.prototype.hasOwnProperty.call(result, "body");
  json(
    response,
    isHttpResult ? result.status : 200,
    isHttpResult ? result.body : result,
    origin,
  );
}

async function respondWithBodyBrowserTask(request: http.IncomingMessage, response: http.ServerResponse, origin: string, task: (body: any) => any): Promise<void> {
  const body = await readBody(request);
  await respondWithBrowserTask(response, origin, () => task(body));
}

function createServer(): http.Server {
  return http.createServer(async (request, response) => {
    const origin = request.headers.origin ?? "";
    if (!isPotentialOrigin(origin)) {
      json(response, 403, { ok: false, message: "허용되지 않은 웹사이트의 요청입니다." });
      return;
    }

    const authorized = isAuthorizedRequest(request, origin);

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-Growth-Log-Token",
        "Access-Control-Allow-Private-Network": "true",
        "Access-Control-Max-Age": "600",
        Vary: "Origin, Access-Control-Request-Private-Network",
      });
      response.end();
      return;
    }

    try {
      if (request.method === "GET" && request.url === "/health") {
        json(response, 200, {
          ok: true,
          service: "growth-log-connector",
          message: authorized ? "연결 앱이 준비되었습니다." : "운영 프로그램 연결 승인이 필요합니다.",
          browserOpen: Boolean(browserContext || embeddedBrowserEndpoint),
          browserMode: embeddedBrowserEndpoint ? "electron" : "chrome",
          queuedBrowserTasks: browserTaskQueue.pending,
          authorized,
          safety: "confirmed-auto-final-submit",
        }, origin);
        return;
      }

      if (!authorized) {
        json(response, 403, {
          ok: false,
          code: "PAIRING_REQUIRED",
          message: "이 운영 프로그램을 연결 앱에서 먼저 승인해 주세요.",
        }, origin);
        return;
      }

      if (request.method === "POST" && request.url === "/login") {
        await respondWithBrowserTask(response, origin, openLogin);
        return;
      }

      if (request.method === "POST" && request.url === "/login-auto") {
        await respondWithBodyBrowserTask(request, response, origin, autoLogin);
        return;
      }

      if (request.method === "POST" && request.url === "/tistory/login") {
        await respondWithBodyBrowserTask(request, response, origin, openTistoryLogin);
        return;
      }

      if (request.method === "POST" && request.url === "/tistory/draft") {
        await respondWithBodyBrowserTask(request, response, origin, prepareTistoryDraft);
        return;
      }

      if (request.method === "POST" && request.url === "/tistory/drafts") {
        await respondWithBodyBrowserTask(request, response, origin, prepareTistoryDraftBatch);
        return;
      }

      if (request.method === "POST" && request.url === "/tistory/modify") {
        await respondWithBodyBrowserTask(request, response, origin, prepareTistoryModification);
        return;
      }

      if (request.method === "POST" && request.url === "/modify") {
        await respondWithBodyBrowserTask(request, response, origin, prepareModification);
        return;
      }

      if (request.method === "POST" && request.url === "/create") {
        await respondWithBodyBrowserTask(request, response, origin, prepareCreation);
        return;
      }

      json(response, 404, { ok: false, message: "요청한 자동화 서비스 경로를 찾을 수 없습니다." }, origin);
    } catch (error) {
      const message = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
      json(response, 500, {
        ok: false,
        code: "AUTOMATION_ERROR",
        message: `브라우저 자동화 오류: ${message}`,
      }, origin);
    }
  });
}

interface StartOptions {
  host?: string;
  port?: number;
  profileDir?: string;
  browserEndpoint?: string;
  automationPageUrl?: string;
  showAutomationWindow?: WindowToggle;
  hideAutomationWindow?: WindowToggle;
  extraAllowedOrigins?: string[];
  isPairedOrigin?: (origin: string, token: string) => boolean;
  quiet?: boolean;
}

export async function startBrowserAutomation({
  host = "127.0.0.1",
  port = Number(process.env.BROWSER_AUTOMATION_PORT ?? 4317),
  profileDir = path.resolve(process.env.BROWSER_AUTOMATION_PROFILE_DIR ?? ".browser-automation-profile"),
  browserEndpoint = "",
  automationPageUrl = "",
  showAutomationWindow = async () => undefined,
  hideAutomationWindow = async () => undefined,
  extraAllowedOrigins = [],
  isPairedOrigin = () => false,
  quiet = false,
}: StartOptions = {}): Promise<ActiveServer> {
  if (activeServer) return activeServer;

  HOST = host;
  PORT = port;
  PROFILE_DIR = path.resolve(profileDir);
  embeddedBrowserEndpoint = String(browserEndpoint ?? "").trim();
  embeddedAutomationPageUrl = String(automationPageUrl ?? "").trim();
  showEmbeddedBrowser = showAutomationWindow;
  hideEmbeddedBrowser = hideAutomationWindow;
  authorizePairedOrigin = isPairedOrigin;
  allowedOrigins = new Set([
    ...allowedOrigins,
    ...extraAllowedOrigins.map((origin) => origin.trim()).filter(Boolean),
  ]);

  if (embeddedBrowserEndpoint) await getContext();

  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : PORT;

  if (!quiet) {
    console.log(`Growth Log connector: http://${HOST}:${actualPort}`);
    console.log(embeddedBrowserEndpoint
      ? "Automation browser: Electron"
      : `Automation browser profile: ${PROFILE_DIR}`);
    console.log("Keep this process open. Final submit runs only after an explicit confirmed request.");
  }

  activeServer = {
    host: HOST,
    port: actualPort,
    openLogin,
    openTistoryLogin,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      if (!embeddedBrowserEndpoint) {
        await browserContext?.close().catch(() => undefined);
      }
      browserConnection = undefined;
      browserContext = undefined;
      workPage = undefined;
      activeServer = undefined;
    },
  };
  return activeServer;
}

const isDirectExecution = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectExecution) {
  const automation = await startBrowserAutomation();
  const shutdown = async () => {
    await automation.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
