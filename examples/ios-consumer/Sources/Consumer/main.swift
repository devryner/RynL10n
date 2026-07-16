import RynL10n

// 빌드 시 RynL10nBakePlugin이 rynl10n/release-snapshot.json을 bake해
// 빌드 산출물에 SDK 번들(snapshot-<base>.json + rynl10n.lock)을 생성한다.
// 런타임에는 그 번들을 로드해 RynL10nClient로 조회한다(이 예제는 빌드 연결 시연이 목적).
print("RynL10n consumer: build tool plugin이 vendored 스냅샷을 자동 bake합니다.")
