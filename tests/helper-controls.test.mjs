import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright-core";
import {
  fillTistoryPostForm,
  normalizeTistoryManageUrl,
  normalizeTistoryTags,
  openEditForm,
  openWriteForm,
  saveTistoryPostForm,
  submitPostForm,
} from "../knou-helper.mjs";

test("opens KNOU write and edit controls and clicks the confirmed final action", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();

  try {
    await page.setContent(`
      <button id="open-write" type="button">게시글 작성</button>
      <div id="accessibility-notice" class="_alertWrap" hidden>
        <h2>알림</h2>
        <p>
          장애인 웹 접근성 준수를 위해 게시판 본문 글쓰기에서 이미지를
          붙여넣기 할 경우 이미지는 저장되지 않습니다.
        </p>
        <div class="_alertFooter">
          <input id="accept-notice" class="confirmBtnOk" type="button" value="YES" />
          <input class="confirmBtnCancel" type="button" value="NO" />
        </div>
      </div>
      <form id="write-form" hidden>
        <label>제목 <input name="artclSj" /></label>
        <button type="submit">등록</button>
      </form>
      <script>
        document.querySelector("#open-write").addEventListener("click", () => {
          document.querySelector("#accessibility-notice").hidden = false;
        });
        document.querySelector("#accept-notice").addEventListener("click", () => {
          document.querySelector("#accessibility-notice").hidden = true;
          document.querySelector("#write-form").hidden = false;
        });
        document.querySelector("#write-form").addEventListener("submit", (event) => {
          event.preventDefault();
          document.body.dataset.submitted = "write";
        });
      </script>
    `);

    assert.equal(await openWriteForm(page), page);
    assert.equal(await page.locator("#accessibility-notice").isVisible(), false);
    assert.equal(await page.locator('input[name="artclSj"]').isVisible(), true);
    assert.equal((await submitPostForm(page, "create")).ok, true);
    assert.equal(await page.locator("body").getAttribute("data-submitted"), "write");

    await page.setContent(`
      <button id="open-edit" type="button">게시글 수정</button>
      <form id="edit-form" hidden>
        <label>제목 <input id="artclSj" /></label>
        <button type="submit">저장</button>
      </form>
      <script>
        document.querySelector("#open-edit").addEventListener("click", () => {
          document.querySelector("#edit-form").hidden = false;
        });
        document.querySelector("#edit-form").addEventListener("submit", (event) => {
          event.preventDefault();
          document.body.dataset.submitted = "edit";
        });
      </script>
    `);

    assert.equal(await openEditForm(page), page);
    assert.equal(await page.locator("#artclSj").isVisible(), true);
    assert.equal((await submitPostForm(page, "modify")).ok, true);
    assert.equal(await page.locator("body").getAttribute("data-submitted"), "edit");
  } finally {
    await browser.close();
  }
});

test("does not bypass CAPTCHA before final submission", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();

  try {
    await page.setContent(`
      <form>
        <input name="artclSj" />
        <div class="g-recaptcha" data-sitekey="test"></div>
        <button type="submit">등록</button>
      </form>
    `);

    const result = await submitPostForm(page, "create");
    assert.equal(result.ok, false);
    assert.equal(result.code, "CAPTCHA_REQUIRED");
  } finally {
    await browser.close();
  }
});

test("normalizes Tistory blog URLs and tags", () => {
  assert.equal(
    normalizeTistoryManageUrl("blog.growthlog.org/category/projects"),
    "https://blog.growthlog.org/manage/newpost/?type=post&returnURL=%2Fmanage%2Fposts%2F",
  );
  assert.equal(normalizeTistoryManageUrl("https://example.com"), "");
  assert.deepEqual(
    normalizeTistoryTags("#방송대, 컴퓨터과학과\n#방송대\n프로젝트"),
    ["방송대", "컴퓨터과학과", "프로젝트"],
  );
});

test("fills a Tistory editor and uses its draft action without publishing", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();

  try {
    await page.setContent(`
      <input id="post-title-inp" />
      <div id="editor" role="textbox" contenteditable="true"></div>
      <div id="tags"></div>
      <input id="tag-input" placeholder="태그입력" />
      <button id="complete" type="button">완료</button>
      <div id="publish-dialog" role="dialog" hidden>
        <label><input id="private" type="radio" name="visibility" />비공개</label>
        <button id="private-save" type="button">비공개 저장</button>
      </div>
      <script>
        document.querySelector("#tag-input").addEventListener("keydown", (event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          const button = document.createElement("button");
          button.type = "button";
          button.setAttribute("aria-label", "태그 삭제");
          button.dataset.tag = event.currentTarget.value;
          document.querySelector("#tags").append(button);
          event.currentTarget.value = "";
        });
        document.querySelector("#complete").addEventListener("click", () => {
          document.querySelector("#publish-dialog").hidden = false;
        });
        document.querySelector("#private-save").addEventListener("click", () => {
          document.body.dataset.saved = document.querySelector("#private").checked ? "private" : "published";
        });
      </script>
    `);

    const filled = await fillTistoryPostForm(page, {
      title: "방송대 컴퓨터과학과 프로젝트",
      html: "<p><strong>본문</strong></p>",
      tags: ["방송대", "컴퓨터과학과"],
    });
    assert.equal(filled.ok, true);
    assert.equal(await page.locator("#post-title-inp").inputValue(), "방송대 컴퓨터과학과 프로젝트");
    assert.equal(await page.locator("#editor").innerHTML(), "<p><strong>본문</strong></p>");
    assert.deepEqual(await page.locator("#tags button").evaluateAll((buttons) => buttons.map((button) => button.dataset.tag)), [
      "방송대",
      "컴퓨터과학과",
    ]);

    const saved = await saveTistoryPostForm(page, "draft");
    assert.equal(saved.ok, true);
    assert.equal(await page.locator("body").getAttribute("data-saved"), "private");
  } finally {
    await browser.close();
  }
});
