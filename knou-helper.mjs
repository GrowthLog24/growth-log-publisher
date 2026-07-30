import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

let HOST = "127.0.0.1";
let PORT = Number(process.env.KNOU_HELPER_PORT ?? 4317);
let PROFILE_DIR = path.resolve(process.env.KNOU_PROFILE_DIR ?? ".knou-playwright-profile");
const LOGIN_URL = "https://m.knou.ac.kr/login?service=https%3A%2F%2Fm.knou.ac.kr";
const TISTORY_LOGIN_URL = "https://www.tistory.com/auth/login";
const MAX_BODY_BYTES = 80_000_000;
const helperDirectory = path.dirname(fileURLToPath(import.meta.url));
let allowedOrigins = new Set(
  (process.env.KNOU_HELPER_ALLOWED_ORIGINS ?? "http://localhost:3000,http://localhost:3001,http://127.0.0.1:3000,http://127.0.0.1:3001")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);
let authorizePairedOrigin = () => false;

let browserContext;
let activeServer;

function json(response, status, value, origin = "") {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
  });
  response.end(JSON.stringify(value));
}

function isPotentialOrigin(origin) {
  if (!origin || allowedOrigins.has(origin)) return true;

  try {
    const url = new URL(origin);
    return url.protocol === "https:"
      || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname));
  } catch {
    return false;
  }
}

function isAuthorizedRequest(request, origin) {
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

function isKnouUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "knou.ac.kr" || url.hostname.endsWith(".knou.ac.kr"));
  } catch {
    return false;
  }
}

function tistoryUrl(value) {
  try {
    const raw = String(value ?? "").trim();
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const isTistoryHost = url.hostname === "tistory.com"
      || url.hostname === "www.tistory.com"
      || url.hostname.endsWith(".tistory.com");
    return url.protocol === "https:" && isTistoryHost ? url : null;
  } catch {
    return null;
  }
}

export function normalizeTistoryManageUrl(value) {
  const url = tistoryUrl(value);
  if (!url || ["tistory.com", "www.tistory.com"].includes(url.hostname)) return "";
  return `${url.origin}/manage/newpost/?type=post&returnURL=%2Fmanage%2Fposts%2F`;
}

export function normalizeTistoryTags(value) {
  const candidates = Array.isArray(value)
    ? value
    : String(value ?? "").split(/[\n,]+/);
  const unique = [];
  const seen = new Set();

  for (const candidate of candidates) {
    const tag = String(candidate ?? "").trim().replace(/^#+/, "").trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    unique.push(tag.slice(0, 50));
    if (unique.length === 10) break;
  }
  return unique;
}

async function readBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("요청 본문이 너무 큽니다.");
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function getContext() {
  if (browserContext) return browserContext;

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

async function getWorkPage() {
  const context = await getContext();
  const pages = context.pages();
  const page = pages.find((candidate) => candidate.url() === "about:blank") ?? (await context.newPage());
  page.setDefaultTimeout(5_000);
  return page;
}

// 사람이 직접 확인·작업해야 하는 순간(로그인·검토 대기·직접 처리 안내)에만 방송대 창을 앞으로 가져옵니다.
// 자동 이동·채우기·제출 단계에서는 포커스를 뺏지 않아 사용자가 그동안 다른 작업을 계속할 수 있습니다.
async function surfaceForUser(page) {
  await page.bringToFront().catch(() => undefined);
}

async function firstVisible(locators) {
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

function searchScopes(page) {
  return [
    page,
    ...page.frames().filter((frame) => frame !== page.mainFrame()),
  ];
}

// 페이지(또는 프레임)를 아래까지 단계적으로 스크롤해 지연 렌더링 요소를 노출시킨 뒤 맨 위로 돌아옵니다.
async function revealByScrolling(scope) {
  await scope.evaluate(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const doc = document.scrollingElement || document.documentElement;
    const step = Math.max(window.innerHeight * 0.8, 400);
    for (let y = 0; y <= doc.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await wait(120);
    }
    window.scrollTo(0, 0);
  }).catch(() => undefined);
}

async function firstVisibleAcrossFrames(page, createLocators) {
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

async function firstExistingAcrossFrames(page, createLocators) {
  for (const scope of searchScopes(page)) {
    for (const locator of createLocators(scope)) {
      if ((await locator.count().catch(() => 0)) > 0) return locator.first();
    }
  }
  return null;
}

function titleLocators(scope) {
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

async function acceptWriteAccessibilityNotice(page) {
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
      await knouAffirmative.scrollIntoViewIfNeeded().catch(() => undefined);
      await knouAffirmative.click({ timeout: 5_000 }).catch(async () => {
        await knouAffirmative.evaluate((element) => {
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

    await affirmative.scrollIntoViewIfNeeded().catch(() => undefined);
    await affirmative.click({ timeout: 5_000 }).catch(async () => {
      await affirmative.evaluate((element) => {
        if (element instanceof HTMLElement) element.click();
      });
    });
    return true;
  }

  return false;
}

async function waitForPostForm(page, timeoutMs = 7_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await acceptWriteAccessibilityNotice(page);
    if (await firstVisibleAcrossFrames(page, titleLocators)) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

async function clickFormControl(page, createLocators) {
  const control = await firstVisibleAcrossFrames(page, createLocators);
  if (!control) return null;

  await control.scrollIntoViewIfNeeded().catch(() => undefined);
  const popupPromise = page.waitForEvent("popup", { timeout: 1_500 }).catch(() => null);
  await control.click({ timeout: 7_000 }).catch(async () => {
    await control.evaluate((element) => {
      if (element instanceof HTMLElement) element.click();
    });
  });

  const popup = await popupPromise;
  const targetPage = popup ?? page;
  await targetPage.waitForLoadState("domcontentloaded", { timeout: 7_000 }).catch(() => undefined);
  await waitForPostForm(targetPage);
  return targetPage;
}

export function openEditForm(page) {
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

export function openWriteForm(page) {
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

async function fillTitle(page, title) {
  const titleField = await firstVisibleAcrossFrames(page, titleLocators);

  if (!titleField) return false;
  await titleField.fill(title);
  return true;
}

async function assignHtml(locator, html) {
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

async function fillHtml(page, html) {
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

async function selectTistoryCategory(page, category) {
  const wanted = String(category ?? "").trim();
  if (!wanted) return { attempted: false, ok: true };

  const nativeSelect = await firstVisibleAcrossFrames(page, (scope) => [
    scope.locator('select[name*="category" i]'),
    scope.locator("select#category"),
  ]);
  if (nativeSelect) {
    const selected = await nativeSelect.selectOption({ label: wanted }).catch(() => []);
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function replaceTistoryTags(page, tags) {
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

export async function fillTistoryPostForm(page, {
  title,
  html,
  tags = [],
  category = "",
} = {}) {
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

function attachmentBuffer(attachment) {
  const dataUrl = String(attachment?.dataUrl ?? "");
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!match) return null;
  const buffer = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  if (buffer.length === 0 || buffer.length > 15_000_000) return null;
  return { buffer, mimeType: match[1].toLowerCase() };
}

function imageExtension(mimeType) {
  return {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
  }[mimeType] ?? ".img";
}

async function tistoryEditorImageSources(page) {
  const sources = [];
  for (const scope of searchScopes(page)) {
    const values = await scope.locator("img[src]").evaluateAll((images) => (
      images.map((image) => image.getAttribute("src") || "").filter(Boolean)
    )).catch(() => []);
    sources.push(...values);
  }
  return new Set(sources);
}

async function uploadTistoryImage(page, filePath) {
  const before = await tistoryEditorImageSources(page);
  const fileInput = await firstExistingAcrossFrames(page, (scope) => [
    scope.locator('input[type="file"][accept*="image" i]'),
    scope.locator('input[type="file"]'),
  ]);

  if (fileInput) {
    await fileInput.setInputFiles(filePath);
  } else {
    const attachmentControl = await firstVisibleAcrossFrames(page, (scope) => [
      scope.getByRole("button", { name: /^첨부$/ }),
      scope.locator('[role="button"][aria-label="첨부"]'),
      scope.locator("#attach-layer-btn"),
    ]);
    if (!attachmentControl) return "";
    await attachmentControl.click();

    const imageMenuItem = await firstVisibleAcrossFrames(page, (scope) => [
      scope.locator("#attach-image"),
      scope.getByRole("menuitem", { name: /^사진$/ }),
      scope.getByText(/^사진$/, { exact: true }),
    ]);
    if (!imageMenuItem) return "";

    const chooserPromise = page.waitForEvent("filechooser", { timeout: 5_000 }).catch(() => null);
    await imageMenuItem.click();
    const chooser = await chooserPromise;
    if (!chooser) return "";
    await chooser.setFiles(filePath);
  }

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(350);
    for (const scope of searchScopes(page)) {
      const uploaded = await scope.locator("img[src]").evaluateAll((images, previousSources) => {
        const previous = new Set(previousSources);
        const image = images.find((candidate) => {
          const source = candidate.getAttribute("src") || "";
          return source
            && !previous.has(source)
            && !source.startsWith("data:")
            && !source.startsWith("blob:");
        });
        if (!image) return null;
        const figure = image.closest("figure");
        return {
          url: image.getAttribute("src") || "",
          figureHtml: (figure || image).outerHTML,
        };
      }, [...before]).catch(() => null);
      if (uploaded?.url) return uploaded;
    }
  }
  return null;
}

function replaceTistoryImagePlaceholder(html, attachmentId, uploaded) {
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

async function uploadTistoryAttachments(page, html, attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return { ok: true, html };
  if (attachments.length > 30) {
    return { ok: false, code: "TOO_MANY_IMAGES", message: "글 하나에는 이미지 30개까지 올릴 수 있습니다." };
  }

  const tempDirectory = await fs.promises.mkdtemp(path.join(process.env.TMPDIR || "/tmp", "growth-log-tistory-"));
  let finalHtml = html;
  try {
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
      const uploaded = await uploadTistoryImage(page, filePath);
      if (!uploaded) {
        return {
          ok: false,
          code: "TISTORY_IMAGE_UPLOAD_FAILED",
          message: `'${String(attachment.name || `${index + 1}번째 이미지`)}' 업로드 결과를 확인하지 못했습니다.`,
        };
      }
      finalHtml = replaceTistoryImagePlaceholder(finalHtml, id, uploaded);
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

async function clickTistoryCompletion(page) {
  const control = await firstVisible([
    page.getByRole("button", { name: /^완료$/ }),
    page.locator("button").filter({ hasText: /^완료$/ }),
  ]);
  if (!control) return false;
  await control.click();
  await page.waitForTimeout(250);
  return true;
}

export async function saveTistoryPostForm(page, mode = "draft") {
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
async function findRegionalCategorySelect(page) {
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
export async function selectRegionalCategory(page, boardName) {
  const region = String(boardName ?? "").replace(/\s*지역대학\s*$/, "").trim();
  if (!region) return { attempted: false };

  const select = await findRegionalCategorySelect(page);
  if (!select) return { attempted: false };

  const matchedValue = await select.evaluate((element, target) => {
    const normalize = (value) => value.replace(/\s+/g, "").trim();
    const wanted = normalize(target);
    const options = Array.from(element.options);
    const option = options.find((item) => normalize(item.textContent) === wanted)
      ?? options.find((item) => {
        const label = normalize(item.textContent);
        return label && (label.includes(wanted) || wanted.includes(label));
      });
    if (!option || !option.value) return "";
    element.value = option.value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return option.value;
  }, region).catch(() => "");

  if (!matchedValue) return { attempted: true, ok: false, region };

  await page.waitForTimeout(700); // jf_selectCl의 하위 분류 로딩 등 후속 처리를 기다립니다.
  return { attempted: true, ok: true, region };
}

async function hasCaptcha(page) {
  for (const scope of searchScopes(page)) {
    const count = await scope.locator(
      'iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], '
      + ".g-recaptcha, .h-captcha, [data-sitekey]",
    ).count().catch(() => 0);
    if (count > 0) return true;
  }
  return false;
}

function finalSubmitLocators(scope, mode) {
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

export async function submitPostForm(page, mode) {
  if (await hasCaptcha(page)) {
    return {
      ok: false,
      code: "CAPTCHA_REQUIRED",
      message: "방송대에서 CAPTCHA 확인이 필요합니다. 전용 Chrome에서 직접 완료한 뒤 다시 시도해 주세요.",
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

  let dialogMessage = "";
  const acceptDialog = async (dialog) => {
    dialogMessage = dialog.message();
    await dialog.accept();
  };
  page.on("dialog", acceptDialog);

  try {
    await submitControl.scrollIntoViewIfNeeded().catch(() => undefined);
    await submitControl.click({ timeout: 7_000 }).catch(async () => {
      await submitControl.evaluate((element) => {
        if (element instanceof HTMLElement) element.click();
      });
    });

    const confirmControl = await firstVisibleAcrossFrames(page, (scope) => [
      scope.getByRole("dialog").getByRole("button", { name: /^(확인|예|등록|저장)$/ }),
    ]);
    if (confirmControl) await confirmControl.click();

    await page.waitForLoadState("domcontentloaded", { timeout: 7_000 }).catch(() => undefined);
    await page.waitForTimeout(800);
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

// ─── 운영 Google Sheets 기록 (게시 성공 시 2차 게시/제목/링크 write-back) ──────────
// GOOGLE_SERVICE_ACCOUNT_KEY(서비스 계정 JSON 원문 또는 파일 경로)가 설정된 경우에만 동작합니다.
// 새 npm 의존성 없이 Node 내장 crypto로 서비스 계정 JWT를 서명해 액세스 토큰을 발급합니다.

const SHEETS_SPREADSHEET_ID = process.env.GROWTH_LOG_SHEETS_ID ?? "1gPZe8cwqKbMU2PBXg2V3mYLLT3MkhdkDZpTXcGqOtE0";
const SHEETS_TAB_CONFIG = {
  department: { gid: "392712092", headerRow: 7 },
  regional: { gid: "1190277445", headerRow: 6 },
};

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function columnLetter(zeroBasedIndex) {
  let index = zeroBasedIndex;
  let letter = "";
  do {
    letter = String.fromCharCode(65 + (index % 26)) + letter;
    index = Math.floor(index / 26) - 1;
  } while (index >= 0);
  return letter;
}

function a1Cell(sheetTitle, oneBasedRow, zeroBasedCol) {
  return `'${String(sheetTitle).replace(/'/g, "''")}'!${columnLetter(zeroBasedCol)}${oneBasedRow}`;
}

// 서비스 계정 키를 환경변수(JSON 원문) 또는 파일 경로에서 읽습니다. 없으면 null.
function readServiceAccount() {
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

async function getSheetsAccessToken(serviceAccount) {
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

async function sheetsFetch(token, pathAndQuery, init) {
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEETS_SPREADSHEET_ID}${pathAndQuery}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`Sheets API ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

// 게시 성공 후 해당 게시판 행에 2차 게시(날짜)·2차 게시 제목·2차 링크를 기록합니다.
// "2차 게시 제목" 열이 없으면 "2차 게시" 열 오른쪽에 새로 삽입합니다.
async function recordSecondRoundCreation({ boardId, title, postUrl }) {
  const serviceAccount = readServiceAccount();
  if (!serviceAccount) return { ok: false, skipped: true, message: "" };

  const match = /^(department|regional)-(.+)$/.exec(String(boardId ?? "").trim());
  if (!match) return { ok: false, message: "시트 기록 생략: 게시판 ID를 해석할 수 없습니다." };
  const [, kind, boardNo] = match;
  const config = SHEETS_TAB_CONFIG[kind];

  const token = await getSheetsAccessToken(serviceAccount);
  const meta = await sheetsFetch(token, "?fields=sheets(properties(sheetId,title))");
  const sheet = (meta.sheets ?? []).find((item) => String(item.properties.sheetId) === config.gid);
  if (!sheet) return { ok: false, message: "시트 기록 실패: 대상 시트 탭을 찾지 못했습니다." };
  const sheetTitle = sheet.properties.title;

  const read = await sheetsFetch(token, `/values/${encodeURIComponent(`'${sheetTitle}'!A${config.headerRow}:ZZ`)}`);
  const rows = read.values ?? [];
  const headers = (rows[0] ?? []).map((cell) => String(cell ?? "").trim());
  const numberCol = headers.indexOf("번호");
  const postCol = headers.indexOf("2차 게시");
  let linkCol = headers.indexOf("2차 링크");
  if (numberCol < 0 || postCol < 0 || linkCol < 0) {
    return { ok: false, message: "시트 기록 실패: 필수 열(번호·2차 게시·2차 링크)을 찾지 못했습니다." };
  }

  const rowOffset = rows.slice(1).findIndex((row) => String(row[numberCol] ?? "").trim() === boardNo.trim());
  if (rowOffset < 0) return { ok: false, message: `시트 기록 실패: 번호 ${boardNo} 행을 찾지 못했습니다.` };
  const targetRow = config.headerRow + 1 + rowOffset;

  let titleCol = headers.indexOf("2차 게시 제목");
  const needsColumn = titleCol < 0;
  if (needsColumn) {
    await sheetsFetch(token, ":batchUpdate", {
      method: "POST",
      body: JSON.stringify({
        requests: [{
          insertDimension: {
            range: { sheetId: sheet.properties.sheetId, dimension: "COLUMNS", startIndex: postCol + 1, endIndex: postCol + 2 },
            inheritFromBefore: true,
          },
        }],
      }),
    });
    titleCol = postCol + 1;
    if (linkCol >= titleCol) linkCol += 1; // 삽입으로 오른쪽 열이 한 칸 밀립니다.
  }

  const today = new Date().toISOString().slice(0, 10);
  const data = [
    { range: a1Cell(sheetTitle, targetRow, postCol), values: [[today]] },
    { range: a1Cell(sheetTitle, targetRow, titleCol), values: [[title]] },
    { range: a1Cell(sheetTitle, targetRow, linkCol), values: [[postUrl]] },
  ];
  if (needsColumn) data.push({ range: a1Cell(sheetTitle, config.headerRow, titleCol), values: [["2차 게시 제목"]] });

  await sheetsFetch(token, "/values:batchUpdate", {
    method: "POST",
    body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
  });
  return { ok: true, message: "운영 시트에 2차 게시·제목·링크를 기록했습니다." };
}

async function openLogin() {
  const page = await getWorkPage();
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  await surfaceForUser(page);
  return {
    ok: true,
    status: "login-opened",
    message: "전용 Chrome 창을 열었습니다. 방송대 로그인을 완료한 뒤 이 창은 그대로 두세요.",
  };
}

async function openTistoryLogin(body = {}) {
  const manageUrl = normalizeTistoryManageUrl(body.blogUrl);
  const targetUrl = manageUrl || TISTORY_LOGIN_URL;
  const page = await getWorkPage();
  await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
  await surfaceForUser(page);
  return {
    ok: true,
    status: "tistory-login-opened",
    message: manageUrl
      ? "티스토리 관리 화면을 열었습니다. 로그인이 필요하면 로그인한 뒤 창을 그대로 두세요."
      : "티스토리 로그인 화면을 열었습니다. 로그인한 뒤 창을 그대로 두세요.",
    pageUrl: page.url(),
  };
}

function validateTistoryPostInput(body, { requirePostUrl = false } = {}) {
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

function isTistoryLoginPage(page) {
  const url = page.url();
  return /accounts\.kakao\.com|\/auth\/login|\/login(?:[/?#]|$)/i.test(url);
}

async function prepareTistoryDraft(body) {
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

  const page = await getWorkPage();
  await page.goto(manageUrl, { waitUntil: "domcontentloaded" });
  if (isTistoryLoginPage(page)) {
    await surfaceForUser(page);
    return {
      status: 409,
      body: {
        ok: false,
        code: "TISTORY_LOGIN_REQUIRED",
        message: "티스토리 로그인이 필요합니다. 열린 전용 Chrome에서 로그인한 뒤 다시 실행해 주세요.",
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
        message: "티스토리 글쓰기 화면을 찾지 못했습니다. 열린 Chrome에서 상태를 확인해 주세요.",
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
  if (!uploaded.ok || !(await fillHtml(page, uploaded.html))) {
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

async function prepareTistoryDraftBatch(body) {
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

  const results = [];
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

async function prepareTistoryModification(body) {
  const input = validateTistoryPostInput(body, { requirePostUrl: true });
  if (!input.ok) return { status: 400, body: input };

  const postUrl = tistoryUrl(body.postUrl);
  const page = await getWorkPage();
  await page.goto(postUrl.href, { waitUntil: "domcontentloaded" });
  if (isTistoryLoginPage(page)) {
    await surfaceForUser(page);
    return {
      status: 409,
      body: {
        ok: false,
        code: "TISTORY_LOGIN_REQUIRED",
        message: "티스토리 로그인이 필요합니다. 열린 전용 Chrome에서 로그인한 뒤 다시 실행해 주세요.",
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
  if (!uploaded.ok || !(await fillHtml(page, uploaded.html))) {
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

async function prepareModification(body) {
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

  const page = await getWorkPage();
  await page.goto(postUrl, { waitUntil: "domcontentloaded" });

  if (page.url().includes("/error.html") || /\/login(?:[/?#]|$)/i.test(page.url())) {
    return {
      status: 409,
      body: {
        ok: false,
        code: "LOGIN_REQUIRED",
        message: "방송대 로그인이 필요합니다. 도우미의 로그인 창에서 로그인한 뒤 다시 시도해 주세요.",
      },
    };
  }

  const editPage = await openEditForm(page);
  if (!editPage) {
    return {
      status: 422,
      body: {
        ok: false,
        code: "EDIT_CONTROL_NOT_FOUND",
        message: "수정 버튼을 찾지 못했습니다. 전용 Chrome에서 로그인 상태와 수정 권한을 확인해 주세요.",
        pageUrl: page.url(),
      },
    };
  }

  const [titleFilled, htmlFilled] = await Promise.all([fillTitle(editPage, title.trim()), fillHtml(editPage, html)]);

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

async function autoLogin(body) {
  const { username, password } = body ?? {};

  if (typeof username !== "string" || username.trim().length === 0 || username.length > 200) {
    return { status: 400, body: { ok: false, code: "INVALID_USERNAME", message: "아이디를 입력해 주세요." } };
  }
  if (typeof password !== "string" || password.length === 0 || password.length > 200) {
    return { status: 400, body: { ok: false, code: "INVALID_PASSWORD", message: "비밀번호를 입력해 주세요." } };
  }

  const page = await getWorkPage();
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

  const usernameField = page.locator("#username");
  const passwordField = page.locator("#password");
  if ((await usernameField.count()) === 0 || (await passwordField.count()) === 0) {
    await surfaceForUser(page);
    return {
      status: 422,
      body: { ok: false, code: "LOGIN_FORM_NOT_FOUND", message: "로그인 입력란을 찾지 못했습니다. 전용 Chrome에서 직접 로그인해 주세요." },
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

async function prepareCreation(body) {
  const { boardId, boardName, boardUrl, title, html, round, confirmFinalSubmit } = body ?? {};

  if (!isKnouUrl(boardUrl)) {
    return { status: 400, body: { ok: false, code: "INVALID_BOARD_URL", message: "방송대 게시판 URL만 열 수 있습니다." } };
  }
  if (typeof title !== "string" || title.trim().length === 0 || title.length > 500) {
    return { status: 400, body: { ok: false, code: "INVALID_TITLE", message: "500자 이하의 게시글 제목을 입력해 주세요." } };
  }
  if (typeof html !== "string" || html.trim().length === 0 || html.length > 600_000) {
    return { status: 400, body: { ok: false, code: "INVALID_HTML", message: "게시할 HTML 내용을 입력해 주세요." } };
  }

  const page = await getWorkPage();
  await page.goto(boardUrl, { waitUntil: "domcontentloaded" });

  if (page.url().includes("/error.html") || /\/login(?:[/?#]|$)/i.test(page.url())) {
    return {
      status: 409,
      body: {
        ok: false,
        code: "LOGIN_REQUIRED",
        message: "방송대 로그인이 필요합니다. 도우미의 로그인 창에서 로그인한 뒤 다시 시도해 주세요.",
      },
    };
  }

  const writePage = await openWriteForm(page);
  if (!writePage) {
    return {
      status: 422,
      body: {
        ok: false,
        code: "WRITE_CONTROL_NOT_FOUND",
        message: "글쓰기 버튼을 찾지 못했습니다. 전용 Chrome에서 로그인 상태와 작성 권한을 확인해 주세요.",
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
          message: `지역 분류에서 '${category.region}'에 해당하는 항목을 찾지 못했습니다. 전용 Chrome에서 분류를 직접 선택한 뒤 다시 시도해 주세요.`,
          pageUrl: writePage.url(),
        },
      };
    }
  }

  const [titleFilled, htmlFilled] = await Promise.all([fillTitle(writePage, title.trim()), fillHtml(writePage, html)]);

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
      return {
        status: 422,
        body: {
          ...submitted,
          pageUrl: writePage.url(),
        },
      };
    }

    // 2차 게시가 실제로 등록된 뒤에만 운영 시트에 2차 게시/제목/링크를 기록합니다.
    // 시트 기록 실패는 이미 성공한 게시를 무효화하지 않도록 안내 문구로만 반영합니다.
    let sheetNote = "";
    if (Number(round) === 2) {
      const recorded = await recordSecondRoundCreation({
        boardId,
        title: title.trim(),
        postUrl: writePage.url(),
      }).catch((error) => ({ ok: false, message: `시트 기록 오류: ${error?.message ?? error}` }));
      if (recorded.message) sheetNote = ` ${recorded.message}`;
    }

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

const WEB_ASSETS = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/app.js", "app.js"],
  ["/styles.css", "styles.css"],
]);

function resolveWebAsset(relativePath) {
  const candidates = [
    path.join(helperDirectory, "web", relativePath),
    path.join(helperDirectory, "..", "web", relativePath),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? "";
}

function serveWebAsset(response, requestPath) {
  const relativePath = WEB_ASSETS.get(requestPath);
  const isZipLibrary = requestPath === "/vendor/jszip.min.js";
  if (!relativePath && !isZipLibrary) return false;
  const filePath = isZipLibrary
    ? [
      path.join(helperDirectory, "node_modules", "jszip", "dist", "jszip.min.js"),
      path.join(helperDirectory, "..", "node_modules", "jszip", "dist", "jszip.min.js"),
    ].find((candidate) => fs.existsSync(candidate))
    : resolveWebAsset(relativePath);
  if (!filePath) return false;

  const contentType = requestPath.endsWith(".js")
    ? "text/javascript; charset=utf-8"
    : requestPath.endsWith(".css")
      ? "text/css; charset=utf-8"
      : "text/html; charset=utf-8";
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  fs.createReadStream(filePath).pipe(response);
  return true;
}

function createServer() {
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
      const requestPath = new URL(request.url, `http://${HOST}`).pathname;
      if (request.method === "GET" && serveWebAsset(response, requestPath)) return;

      if (request.method === "GET" && request.url === "/health") {
        json(response, 200, {
          ok: true,
          service: "growth-log-connector",
          message: authorized ? "연결 앱이 준비되었습니다." : "운영 프로그램 연결 승인이 필요합니다.",
          browserOpen: Boolean(browserContext),
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
        json(response, 200, await openLogin(), origin);
        return;
      }

      if (request.method === "POST" && request.url === "/login-auto") {
        const result = await autoLogin(await readBody(request));
        json(response, result.status, result.body, origin);
        return;
      }

      if (request.method === "POST" && request.url === "/tistory/login") {
        json(response, 200, await openTistoryLogin(await readBody(request)), origin);
        return;
      }

      if (request.method === "POST" && request.url === "/tistory/draft") {
        const result = await prepareTistoryDraft(await readBody(request));
        json(response, result.status, result.body, origin);
        return;
      }

      if (request.method === "POST" && request.url === "/tistory/drafts") {
        const result = await prepareTistoryDraftBatch(await readBody(request));
        json(response, result.status, result.body, origin);
        return;
      }

      if (request.method === "POST" && request.url === "/tistory/modify") {
        const result = await prepareTistoryModification(await readBody(request));
        json(response, result.status, result.body, origin);
        return;
      }

      if (request.method === "POST" && request.url === "/modify") {
        const result = await prepareModification(await readBody(request));
        json(response, result.status, result.body, origin);
        return;
      }

      if (request.method === "POST" && request.url === "/create") {
        const result = await prepareCreation(await readBody(request));
        json(response, result.status, result.body, origin);
        return;
      }

      json(response, 404, { ok: false, message: "요청한 도우미 경로를 찾을 수 없습니다." }, origin);
    } catch (error) {
      const message = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
      json(response, 500, {
        ok: false,
        code: "HELPER_ERROR",
        message: `로컬 도우미 오류: ${message}`,
      }, origin);
    }
  });
}

export async function startKnouHelper({
  host = "127.0.0.1",
  port = Number(process.env.KNOU_HELPER_PORT ?? 4317),
  profileDir = path.resolve(process.env.KNOU_PROFILE_DIR ?? ".knou-playwright-profile"),
  extraAllowedOrigins = [],
  isPairedOrigin = () => false,
  quiet = false,
} = {}) {
  if (activeServer) return activeServer;

  HOST = host;
  PORT = port;
  PROFILE_DIR = path.resolve(profileDir);
  authorizePairedOrigin = isPairedOrigin;
  allowedOrigins = new Set([
    ...allowedOrigins,
    ...extraAllowedOrigins.map((origin) => origin.trim()).filter(Boolean),
  ]);

  const server = createServer();
  await new Promise((resolve, reject) => {
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
    console.log(`Dedicated Chrome profile: ${PROFILE_DIR}`);
    console.log("Keep this process open. Final submit runs only after an explicit confirmed request.");
  }

  activeServer = {
    host: HOST,
    port: actualPort,
    openLogin,
    openTistoryLogin,
    dashboardUrl: `http://${HOST}:${actualPort}/`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await browserContext?.close().catch(() => undefined);
      browserContext = undefined;
      activeServer = undefined;
    },
  };
  return activeServer;
}

const isDirectExecution = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectExecution) {
  const helper = await startKnouHelper();
  const shutdown = async () => {
    await helper.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
