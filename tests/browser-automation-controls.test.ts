import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright-core";
import {
  fillKnouHtml,
  fillTistoryPostForm,
  knouArticleNo,
  knouMessageRedirectUrl,
  matchesPostTitle,
  normalizeTistoryManageUrl,
  normalizeTistoryTags,
  openEditForm,
  openWriteForm,
  resolvePostingRoundColumns,
  saveTistoryPostForm,
  submitPostForm,
  uploadTistoryAttachments,
} from "../src/browser-automation.js";

test("maps or creates a complete posting-round column group", () => {
  assert.deepEqual(resolvePostingRoundColumns(["번호", "1차 게시", "1차 게시 제목", "1차 링크", "1차 소계"], 1), {
    names: ["1차 게시", "1차 게시 제목", "1차 링크", "1차 소계"],
    indexes: [1, 2, 3, 4],
    insertAt: -1,
  });
  assert.deepEqual(resolvePostingRoundColumns(["번호"], 2), {
    names: ["2차 게시", "2차 게시 제목", "2차 링크", "2차 소계"],
    indexes: [1, 2, 3, 4],
    insertAt: 1,
  });
  assert.throws(() => resolvePostingRoundColumns(["번호", "3차 게시"], 3), /3차 열 구조가 불완전/);
});

test("extracts the board list URL from the KNOU post-submit message page", () => {
  const messageUrl = "https://law.knou.ac.kr/message/message.do?siteId=law"
    + "&message=%EA%B2%8C%EC%8B%9C%EB%AC%BC%EC%9D%84%28%EB%A5%BC%29+%EB%93%B1%EB%A1%9D%ED%96%88%EC%8A%B5%EB%8B%88%EB%8B%A4."
    + "&location=%2Fbbs%2Flaw%2F2210%2FartclList.do%3Fpage%3D1%26layout%3DvHzWp64Tf%252BQaMalMHiNLJA%253D%253D";
  assert.equal(
    knouMessageRedirectUrl(messageUrl),
    "https://law.knou.ac.kr/bbs/law/2210/artclList.do?page=1&layout=vHzWp64Tf%2BQaMalMHiNLJA%3D%3D",
  );

  // 안내 페이지가 아니거나 location이 없으면 손대지 않습니다.
  assert.equal(knouMessageRedirectUrl("https://law.knou.ac.kr/bbs/law/2210/807731/artclView.do"), null);
  assert.equal(knouMessageRedirectUrl("https://law.knou.ac.kr/message/message.do?siteId=law"), null);
  assert.equal(knouMessageRedirectUrl("not-a-url"), null);
});

test("reads the KNOU article number from both post URL shapes", () => {
  // 경로에 글 번호가 그대로 들어있는 형태
  assert.equal(knouArticleNo("https://jpn.knou.ac.kr/bbs/jpn/2195/807731/artclView.do"), 807731);
  // enc(base64 안에 URL 인코딩된 경로)에 들어있는 형태
  assert.equal(
    knouArticleNo(
      "https://jpn.knou.ac.kr/jpn/5205/subview.do"
      + "?enc=Zm5jdDF8QEB8JTJGYmJzJTJGanBuJTJGMjE5NSUyRjgwNjM2MCUyRmFydGNsVmlldy5kbyUzRg%3D%3D",
    ),
    806360,
  );
  // 상대 경로도 목록 주소를 기준으로 해석합니다.
  assert.equal(
    knouArticleNo("/bbs/law/2210/807731/artclView.do", "https://law.knou.ac.kr/bbs/law/2210/artclList.do"),
    807731,
  );
  // 글 번호를 알 수 없는 링크
  assert.equal(knouArticleNo("#"), null);
  assert.equal(knouArticleNo("https://law.knou.ac.kr/bbs/law/2210/artclList.do?page=1"), null);

  // 같은 제목이 여럿일 때 가장 큰 번호가 방금 올린 글입니다.
  const listed = [
    "https://law.knou.ac.kr/bbs/law/2210/806364/artclView.do",
    "https://law.knou.ac.kr/bbs/law/2210/808850/artclView.do",
    "https://law.knou.ac.kr/bbs/law/2210/807731/artclView.do",
  ];
  const newest = listed.reduce((best, url) => (knouArticleNo(url)! > knouArticleNo(best)! ? url : best));
  assert.equal(newest, "https://law.knou.ac.kr/bbs/law/2210/808850/artclView.do");
});

test("matches list titles despite icon text, whitespace and truncation", () => {
  const title = "[신입 모집] 나의 아이디어를 AI로 실현하는 곳, 그로스로그";

  assert.equal(matchesPostTitle(title, title), true);
  // 줄바꿈·중복 공백
  assert.equal(matchesPostTitle("[신입 모집]  나의 아이디어를 AI로\n실현하는 곳, 그로스로그", title), true);
  // "새글"·"첨부파일" 같은 아이콘 텍스트가 붙는 경우
  assert.equal(matchesPostTitle(`${title} 새글`, title), true);
  assert.equal(matchesPostTitle(`첨부파일 ${title}`, title), true);
  // 목록에서 말줄임된 경우
  assert.equal(matchesPostTitle("[신입 모집] 나의 아이디어를 AI로 실현하는…", title), true);
  assert.equal(matchesPostTitle("[신입 모집] 나의 아이디어를 AI로 실현하는...", title), true);

  // 다른 글은 걸리면 안 됩니다.
  assert.equal(matchesPostTitle("[신입 모집] AI를 배우고 활용하고 싶은 방송대 학우, 그로스로그와 함께해요", title), false);
  assert.equal(matchesPostTitle("이전글", title), false);
  assert.equal(matchesPostTitle("", title), false);
  // 짧은 조각은 말줄임 규칙으로도 통과시키지 않습니다.
  assert.equal(matchesPostTitle("[신입…", title), false);
});

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
          window.alert("게시글 등록이 완료되었습니다.");
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
          window.alert("게시글 저장이 완료되었습니다.");
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

test("switches Namo to HTML mode and fills the exact source textarea", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();

  try {
    await page.setContent(`
      <button id="NamoSE_editorhtml" type="button">HTML</button>
      <textarea
        id="NamoSE_editorhtml_editor"
        class="NamoSE_html_frame"
        title="HTML 편집 모드"
        style="display: none; width: 500px; height: 200px"
      ></textarea>
      <script>
        document.querySelector("#NamoSE_editorhtml").addEventListener("click", () => {
          document.querySelector("#NamoSE_editorhtml_editor").style.display = "block";
        });
        document.querySelector("#NamoSE_editorhtml_editor").addEventListener("change", () => {
          document.body.dataset.sourceChanged = "true";
        });
      </script>
    `);

    const html = "<p><strong>방송대 본문</strong></p>";
    assert.equal(await fillKnouHtml(page, html), true);
    assert.equal(await page.locator("#NamoSE_editorhtml_editor").inputValue(), html);
    assert.equal(await page.locator("body").getAttribute("data-source-changed"), "true");
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

test("uploads multiple Tistory images in one file-input operation", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();

  try {
    await page.setContent(`
      <div id="editor" role="textbox" contenteditable="true"><p>본문</p></div>
      <input id="main-image-upload" type="file" accept="image/*" multiple />
      <script>
        const editor = document.querySelector("#editor");
        const mainUpload = document.querySelector("#main-image-upload");

        document.addEventListener("keydown", (event) => {
          if (event.key === "Escape") document.querySelector("#image-replace-toolbar")?.remove();
        });

        mainUpload.addEventListener("change", (event) => {
          for (const file of event.currentTarget.files) {
            const figure = document.createElement("figure");
            const imageWrapper = document.createElement("span");
            imageWrapper.dataset.url = "https://cdn.example/" + file.name;
            const image = document.createElement("img");
            image.src = "blob:preview-" + file.name;
            image.tabIndex = 0;
            image.dataset.mceSelected = "1";
            imageWrapper.append(image);
            figure.append(imageWrapper);
            editor.append(figure);
            image.focus();
          }

          document.querySelector("#image-replace-toolbar")?.remove();
          const toolbar = document.createElement("div");
          toolbar.id = "image-replace-toolbar";
          toolbar.className = "image-toolbar";
          toolbar.innerHTML = '<input id="replace-image-upload" type="file" accept="image/*" />';
          document.body.prepend(toolbar);
          document.body.dataset.mainUploads = String(event.currentTarget.files.length);
          document.body.dataset.uploadEvents = String(Number(document.body.dataset.uploadEvents || 0) + 1);
        });

        document.addEventListener("change", (event) => {
          if (event.target.id !== "replace-image-upload") return;
          document.body.dataset.replacementUsed = "true";
        });
      </script>
    `);

    const result = await uploadTistoryAttachments(
      page,
      [
        '<figure data-ke-type="image"><img src="growthlog-asset://asset-1" alt="첫 이미지" /></figure>',
        '<figure data-ke-type="image"><img src="growthlog-asset://asset-2" alt="둘째 이미지" /></figure>',
      ].join("\n"),
      [
        { id: "asset-1", name: "first.jpg", dataUrl: "data:image/jpeg;base64,AA==" },
        { id: "asset-2", name: "second.jpg", dataUrl: "data:image/jpeg;base64,AQ==" },
      ],
    );

    assert.equal(result.ok, true);
    assert.equal(await page.locator("body").getAttribute("data-main-uploads"), "2");
    assert.equal(await page.locator("body").getAttribute("data-upload-events"), "1");
    assert.equal(await page.locator("body").getAttribute("data-replacement-used"), null);
    assert.doesNotMatch(result.html, /growthlog-asset:\/\//);
    assert.match(result.html, /https:\/\/cdn\.example\/01\.jpg/);
    assert.match(result.html, /https:\/\/cdn\.example\/02\.jpg/);
  } finally {
    await browser.close();
  }
});
