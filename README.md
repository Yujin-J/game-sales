# Game Sales Table

Google Play 게임 매출 순위를 한국, 일본, 미국 기준으로 확인하는 웹 대시보드입니다.

## 현재 구현

- 국가별 매출 순위 100위 테이블
- 순위, 게임 이름, 출시 국가, 전일 대비 등락 표시
- 상승은 빨간색 `▲ +값`, 하락은 파란색 `▼ -값`
- 게임 정보 테이블과 날짜별 순위 테이블 분리
- 로컬 확인용 Node 서버
- 목업 데이터 제거: 화면은 서버 API 데이터만 사용

## 실제 데이터 소스

기본값은 `google-play-scraper`의 Google Play `GROSSING` 컬렉션과 `GAME` 카테고리입니다. 한국, 일본, 미국 국가 코드를 각각 `kr`, `jp`, `us`로 호출합니다.

별도 랭킹 API가 있으면 `PLAY_STORE_API_URL`을 설정하세요. URL에 `{market}`이 있으면 `KR`, `JP`, `US`로 치환하고, 없으면 `market` 쿼리 파라미터를 붙입니다.

Google Play 공개 차트에는 게임의 출시 국가가 항상 제공되지 않습니다. API 응답에 출시 국가가 없으면 `미확인`으로 저장합니다.

## Supabase 테이블

`game_infos`

- 게임 이름
- 게임 장르
- 출시 국가
- 게임 출시일

`game_daily_rankings`

- 날짜와 시각
- 순위 기준 국가
- 순위 날짜
- 순위
- 게임 정보 참조값
- 어제와 비교한 순위 등락 값

처음 순위권에 들어온 게임은 `game_infos`에 먼저 저장하고, 이후 날짜별 순위는 `game_daily_rankings`에 저장합니다.

## 로컬 실행

실제 데이터만 사용하므로 `index.html`을 직접 열면 데이터가 표시되지 않습니다.

서버를 실행한 뒤 확인하세요.

```powershell
npm.cmd install
npm.cmd start
```

그 다음 `http://localhost:8080`을 엽니다.

## 환경 변수

로컬에서는 프로젝트 루트에 `.env` 파일을 만들고 아래 값을 입력합니다. `.env.example`을 참고하세요.

```text
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
PLAY_STORE_API_URL=
PLAY_STORE_API_KEY=
SYNC_SECRET=
PORT=8080
```

`PLAY_STORE_API_URL`은 `{market}` 플레이스홀더를 지원합니다. 예: `https://example.com/rankings?country={market}`.

현재 PowerShell 세션에서 값이 들어갔는지 확인:

```powershell
$env:SUPABASE_URL
$env:SUPABASE_SERVICE_ROLE_KEY
$env:SYNC_SECRET
```

`.env` 파일을 쓰지 않고 현재 PowerShell 세션에만 임시로 넣을 때:

```powershell
$env:SUPABASE_URL="https://your-project-ref.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"
$env:SYNC_SECRET="replace-with-a-long-random-secret"
npm.cmd start
```

Cloud Run에는 배포할 때 환경변수로 입력합니다.

```powershell
gcloud run deploy game-sales-table `
  --source . `
  --region asia-northeast3 `
  --allow-unauthenticated `
  --set-env-vars "SUPABASE_URL=https://your-project-ref.supabase.co,SYNC_SECRET=replace-with-a-long-random-secret" `
  --set-secrets "SUPABASE_SERVICE_ROLE_KEY=supabase-service-role-key:latest"
```

## 수집

무료 배포 구성에서는 GitHub Actions가 매일 한국 시간 21:00에 데이터를 수집합니다. 수집 결과는 Supabase에 저장하고, GitHub Pages가 읽을 최신 JSON 파일도 같이 생성합니다.

GitHub Actions cron:

```text
0 12 * * *
```

GitHub Actions cron은 UTC 기준이라 `12:00 UTC`가 `21:00 Asia/Seoul`입니다.

GitHub 저장소 Secrets에 아래 값을 넣어야 합니다.

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- 선택: `PLAY_STORE_API_URL`
- 선택: `PLAY_STORE_API_KEY`

GitHub Pages는 정적 파일만 제공하고, 저장 작업은 GitHub Actions에서만 실행합니다. `SUPABASE_SERVICE_ROLE_KEY`는 브라우저에 노출되지 않습니다.

## GitHub Pages 배포

저장소가 아직 없다면 GitHub에서 새 repository를 만들고 이 로컬 저장소에 remote를 연결합니다.

```powershell
git remote add origin https://github.com/<owner>/<repo>.git
git branch -M main
git push -u origin main
```

저장소 설정에서 Pages source를 `GitHub Actions`로 선택합니다.

자동 배포:

- `main` 또는 `master`에 push하면 정적 화면을 배포합니다.
- 매일 21:00 KST에 순위를 수집하고 최신 JSON과 함께 다시 배포합니다.

수동 실행:

- GitHub Actions 탭에서 `Sync Rankings` 워크플로를 `Run workflow`로 실행합니다.

GitHub Actions가 재시도되더라도 `game_daily_rankings`는 `market_country`, `ranking_date`, `rank` 기준으로 upsert되므로 같은 날짜의 같은 순위가 중복 저장되지 않습니다.

## 로컬 수집 테스트

`.env`에 Supabase 값을 넣은 뒤 아래 명령으로 오늘자 데이터를 Supabase에 저장하고 Pages용 JSON을 만들 수 있습니다.

```powershell
npm.cmd run sync:rankings -- --out dist/data
npm.cmd run build:pages -- --preserve-data
```
