# RynL10n Android SDK — 앱 적용 가이드

기존 Android 앱에 RynL10n을 붙이는 전체 절차. 서버 준비 → 빌드 연결 → 런타임 연결 순서로 진행한다.
알고리즘·골든 벡터 등 SDK 내부는 [`../README.md`](../README.md), 서버 운영은
[`../../OPERATIONS.md`](../../OPERATIONS.md)를 참조한다.

**요구 사항**: minSdk 26 / JDK 17+ / Kotlin 2.1+.

---

## 0. 그림

```
빌드타임 ─ rynl10nBake 태스크 ─→ assets/rynl10n/snapshot.json ─→ 앱 번들 (fallback, 항상 완전)
런타임  ─ RemoteDeliveryStore ─→ manifest → 델타/스냅샷       ─→ 오버레이 (키 단위 덮어쓰기)
```

두 계층이 독립이라 **원격이 실패해도 화면은 번들 값으로 정상 동작한다.** SDK는 배포 플레인(정적 파일)만
읽고 관리 API는 절대 호출하지 않는다.

---

## 1. 서버에 프로젝트 만들기

서버를 아직 안 띄웠다면 `docker compose up`(또는 `npm run backend`). 대시보드는
<http://localhost:8787>, 배포 플레인은 <http://localhost:8788>.

절차는 플랫폼과 무관하므로 [iOS 가이드 §1](../ios/README.md#1-서버에-프로젝트-만들기)의 curl 예제를
그대로 쓰면 된다. 하나만 주의한다:

> **`versionMatch`는 앱의 `versionName` 기준이다.** 여기서 정한 범위에 앱 버전이 들어가지 않으면
> 런타임은 번들만 쓴다(원격 갱신이 조용히 무시되는 가장 흔한 원인). 빌드넘버로 매칭하려면
> `integer-range` 전략과 `versionCode`를 쓴다.

---

## 2. 의존성 추가

```kotlin
// 앱 모듈 build.gradle.kts
dependencies {
    implementation("com.devryner.rynl10n:android:0.1.0")
}
```

> **아직 Maven Central에 게시되지 않았다**(기획서 6.5 · M5). 지금 붙이려면 저장소를 클론해
> `cd sdks/android && ./gradlew :library:publishToMavenLocal` 후 앱의 `repositories`에
> `mavenLocal()`을 추가한다.

Compose를 쓰지 않는 앱도 그대로 쓸 수 있다 — Compose 어댑터는 `compileOnly` 의존이라
**SDK가 Compose를 끌고 들어가지 않는다.**

---

## 3. 빌드타임 번들링 연결 (차별점 ①)

번들은 **네트워크가 없어도 모든 키가 채워져 있게** 만드는 안전망이다. 빌드마다 자동으로 굽는다.

### 3-a. bake 태스크를 빌드 그래프에 물리기

`rynl10nBake`는 이 저장소의 `sdks/android` 빌드가 제공하는 태스크다. 앱 저장소에서는 CI가
스냅샷을 받아 `assets/`에 떨궈두는 형태가 가장 단순하다:

```bash
# CI: 최신 릴리스 스냅샷을 받아 앱 모듈 assets로 bake
#     서버가 죽어 있으면 --cache 의 마지막 성공본으로 진행한다(빌드가 서버에 종속되지 않음)
./gradlew rynl10nBake \
  -Pfetch="$API/projects/myapp/releases/R1/snapshot" -Ptoken="$TOKEN" \
  -Pcache=.rynl10n-cache.json \
  -Pout=<앱 모듈>/src/main/assets -PstableName=true
```

산출물은 `assets/rynl10n/snapshot.json` + `assets/rynl10n/rynl10n.lock`이다.
`-PstableName=true`가 파일명을 고정해 주므로 런타임 로더가 바로 찾는다.

에어갭·오프라인 빌드라면 `-Pfetch` 대신 커밋해 둔 스냅샷 파일을 `-Psource=`로 넘긴다.

`-PemitNative=true`를 더하면 `res/values-<locale>/strings.xml`도 함께 방출한다 —
`getString(R.string.…)`을 쓰는 기존 코드에 fallback을 주고 싶을 때만 쓰면 된다(선택).
대시보드에 적은 **키 설명이 XML 주석으로 구워져** 번역자에게 맥락이 전달된다.

### 3-b. 확인

빌드 로그에 `[rynl10n] bake 완료: release=… base=… keys=…`가 찍히고 `assets/rynl10n/`이 채워진다.
**커밋할 산출물은 없다** — `.gitignore`에 `src/main/assets/rynl10n/`을 넣어두면 된다.

---

## 4. 런타임 연결

### 4-a. 초기화

`Application.onCreate`에서 한 번. 번들 로드는 assets 디스크 I/O뿐이라 스플래시에서 네트워크를
기다릴 일이 없다.

```kotlin
class App : Application() {
    override fun onCreate() {
        super.onCreate()
        RynL10n.configure(
            context = this,
            project = "myapp",
            endpoint = "https://cdn.example.com",   // 배포 플레인/CDN 루트 (관리 API 아님)
        )
    }
}
```

`appVersion`은 기본적으로 `PackageInfo.versionName`, `buildNumber`는 `longVersionCode`를 쓴다.
릴리스 매칭을 다른 값으로 하려면 인자로 넘긴다.

번들이 없으면 `BakedBundle.BakedException`이 나면서 무엇을 확인해야 하는지 알려준다.
`endpoint`를 생략하면 번들 전용으로 동작한다(에어갭 빌드).

### 4-b. 조회

```kotlin
textView.text = RynL10n.t("home.title")
textView.text = RynL10n.t("cart.items", mapOf("n" to count))   // CLDR 복수형
textView.text = RynL10n.t("home.title", locale = "ja")         // 로케일 강제

// Context 확장 — getString 대체
textView.text = context.rynl10n("home.title")
```

`t`는 **동기**다. 항상 번들 fallback이 있으므로 블로킹 네트워크가 없다.
미해결 키는 `⟪key⟫`로 표면화된다(조용한 빈 문자열 금지).

### 4-c. Compose

```kotlin
Text(rynl10nString("home.title"))
Text(rynl10nString("cart.items", mapOf("n" to count)))
```

원격 갱신이 적용되면 `RynL10nState.version`이 올라가고, 이를 구독한 컴포저블만 재구성된다.
직접 구독하려면 `RynL10n.state.version.collectAsState()`를 쓴다.

### 4-d. 원격 갱신 — 언제 부르나

`update()`가 한 사이클을 전부 처리한다: manifest 조회(ETag) → **내 앱 버전에 맞는 릴리스 선택** →
필요한 산출물만 다운로드 → 원자적 스왑. 이미 가진 산출물은 다시 받지 않는다(내용해시 URL = 영구 캐시).

기본 시점은 **앱 시작 직후**와 **포그라운드 복귀**다.

```kotlin
class MainActivity : ComponentActivity() {
    override fun onStart() {
        super.onStart()
        lifecycleScope.launch { runCatching { RynL10n.update() } }
    }
}
```

프로세스 단위로 한 번만 돌리려면 `ProcessLifecycleOwner`의 `ON_START`에 붙인다.

실패를 삼켜도 되는 이유: 실패는 **이전 상태 유지**를 뜻할 뿐 화면이 깨지지 않는다.
네트워크가 끊겨 있으면 마지막으로 받은 manifest·산출물 캐시로 진행하고, 캐시조차 없으면
`DeliveryException.Unavailable`을 던진 뒤 번들 그대로 동작한다.

---

## 5. 번역 고치고 배포하기

대시보드에서 값을 고치고 publish하면 끝이다. 앱은 다음 `update()` 때 델타를 받아 반영한다.
문제가 생기면 롤백은 manifest 포인터 되돌리기라 즉시·무손실이다([iOS 가이드 §5](../ios/README.md) 참조).

---

## 6. 문제 해결

| 증상 | 원인 | 확인 |
| --- | --- | --- |
| 모든 값이 `⟪key⟫` | 번들이 비었음 | 빌드 로그에 `[rynl10n] bake 완료`가 있는지, `assets/rynl10n/snapshot.json` 존재 여부 |
| `BakedException` | bake 태스크 미연결 / 출력이 assets 밖 | `-Pout=<앱 모듈>/src/main/assets -PstableName=true` 인지 |
| 번들 값만 나오고 원격이 안 붙음 | 앱 버전이 릴리스 범위 밖 | `RynL10n.client.status().selection`이 `bundle-only`면 그것. manifest의 `versionMatch` 확인 |
| 특정 키만 옛 값 | 포맷 안전 가드 | 오버레이의 플레이스홀더 서명이 번들과 다르면 그 키만 번들로 fallback(크래시 방지). 서버에서 키 `placeholders` 확인 |
| `DeliveryException.BadStatus(404)` | 배포 플레인 경로/프로젝트 ID 불일치 | `curl $CDN/{project}/manifest.json` |
| 값이 안 바뀜 (서버는 바뀜) | manifest ETag 캐시 | manifest는 짧은 TTL. 즉시 확인하려면 `RynL10n.store?.clearCache()` |
| Compose에서 `NoClassDefFoundError` | Compose 없는 앱이 `rynl10nString` 호출 | Compose 어댑터는 `compileOnly` — Compose를 쓰지 않으면 `RynL10n.t`를 쓴다 |

`RynL10n.configure(telemetry = "aggregate")`로 켜면 `client.drainTelemetry()`가 익명 집계 카운트
(`overlayApplied` / `formatGuardRejected` / `keyUnresolved` / `deltaFailed`)를 돌려준다.
값·키명·기기 식별자는 포함되지 않는다.

---

## 7. 검증 범위 (정직하게)

- **검증됨**: 코어 40개 테스트 통과 — 골든 벡터 정합 + 시나리오 A/B/C + **배포 플레인 HTTP 9개**
  (JDK 내장 HTTP 서버를 실제로 띄워 ETag·304·오프라인 폴백·불변 캐싱까지) + **번들 로더 8개**
  (bake 산출물을 실제로 구워 다시 읽는 왕복). AAR 빌드와 `publishToMavenLocal`도 확인됨.
- **미검증**: **실제 Android 앱 모듈에서의 end-to-end.** assets 병합, `PackageInfo` 기반 버전 판정,
  Compose 재구성은 코드만 준비된 상태다 — 이 저장소에 앱 모듈이 없어 계측 테스트를 돌리지 못했다.
  처음 붙일 때 ① 빌드 로그의 `[rynl10n] bake 완료` ② `RynL10n.client.status()`가 기대한 릴리스를
  가리키는지부터 확인할 것.
- **미게시**: Maven Central 배포는 계정·서명 키 준비가 남아 있다(기획서 6.5 · M5).

---

## 저장소 구조 (기여자용)

```
sdks/android/
  build.gradle.kts        루트 = 결정적 코어(JVM). 배포하지 않는다.
  src/main/kotlin/        코어 — :library가 이 소스를 그대로 컴파일해 AAR에 넣는다
  src/cli/kotlin/         bake CLI(java.net.http 사용 — Android에 없는 API라 AAR에서 제외)
  src/test/kotlin/        골든 벡터·시나리오·배포 플레인·번들 로더 테스트 (Android SDK 불요)
  library/                배포 아티팩트(AAR) — com.devryner.rynl10n:android
    src/main/kotlin/      Android 바인딩만(assets 로더·configure 파사드·Compose 어댑터)
```

**골든 벡터 검증은 루트 JVM 모듈에 남아 Android SDK 없이 돌아간다** — AAR 모듈을 더하면서도
`./gradlew test`의 전제 조건이 늘어나지 않게 한 것이 이 구조의 이유다.
