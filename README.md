# Growth Log 브라우저 자동화

Electron 내부의 전용 자동화 브라우저를 이용해 방송대 게시 작업과 티스토리 임시저장을 돕는 연결 앱입니다. Electron은 로컬 자동화 서버와 트레이 앱을 실행하고, 이미 연결된 외부 운영 웹의 자동화 요청을 처리합니다.

연결된 운영 웹에서는 다음 작업을 할 수 있습니다.

- Markdown과 이미지가 함께 든 ZIP을 열어 여러 글을 순서대로 티스토리에 비공개 저장
- Markdown의 제목, 굵게, 목록, 표, 링크, 이미지와 이미지 설명을 HTML로 변환
- `#태그` 또는 frontmatter의 `tags`를 티스토리 태그로 등록
- 한 글을 직접 입력해 임시저장
- 기존 티스토리 글의 수정 화면에 내용을 채운 뒤 사람이 최종 확인

ZIP 안의 이미지 경로는 Markdown 파일을 기준으로 한 상대경로여야 합니다.

```text
tistory_gl5_subjects/
├── gl5-example-study.md
└── images/
    └── example.png
```

```md
![이미지 아래에 표시할 설명](images/example.png)
```

새 글 작업의 기본 동작은 공개 발행이 아닌 비공개 저장입니다. 티스토리의 단순 임시저장은 태그를 보존하지 않으므로, 다시 수정할 수 있으면서 태그까지 유지되는 비공개 글로 저장합니다.

## 구성

```text
src/              Electron 트레이 앱
browser-automation.mjs   Playwright 브라우저 자동화와 로컬 HTTP 서버
tests/            자동화 및 서버 테스트
```

실행 방식은 `npm start` 하나로 통일합니다. 자동화 브라우저의 로그인 상태는 Electron의 사용자별 앱 데이터에 저장됩니다. 평상시 자동화 창은 숨겨진 상태로 동작하며, 로그인·CAPTCHA·오류 확인이 필요할 때만 화면에 표시됩니다.

## 개발 실행

```bash
npm install
npm start
```

`npm start`가 Electron 트레이 앱, 내장 자동화 브라우저와 로컬 자동화 서버를 함께 실행합니다. 로컬 작업 웹은 제공하지 않으며, 연결된 외부 운영 웹에서 작업을 실행합니다.

## macOS 패키지 생성

```bash
npm run make
```

생성된 앱은 `out/make`에서 확인할 수 있습니다. 외부 운영진에게 배포할 때는 macOS 코드 서명과 공증을 추가해야 합니다.

연결 앱은 `growthlog-connector://pair` 딥링크를 처리하고, 사용자가 승인한 HTTPS 운영 프로그램과 이 컴퓨터의 로컬 화면만 자동화 API를 호출할 수 있게 합니다.
