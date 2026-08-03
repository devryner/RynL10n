package com.rynl10n

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember

/**
 * Compose 바인딩 — 기획서 6.2의 `stringResource` 대응.
 *
 * Compose 런타임은 `compileOnly` 의존이라 **이 파일을 쓰지 않는 앱은 Compose를 끌고 들어가지 않는다.**
 * (Compose를 쓰지 않는 앱에서 이 함수를 호출하면 `NoClassDefFoundError`가 난다 — 그 앱은 애초에
 * 이 함수를 참조하지 않는다.)
 *
 * ```kotlin
 * Text(rynl10nString("home.title"))
 * Text(rynl10nString("cart.items", mapOf("n" to count)))   // CLDR 복수형
 * ```
 *
 * 원격 갱신이 적용되면 [RynL10nState.version]이 올라가고, 이를 구독한 컴포저블만 재구성된다.
 */
@Composable
fun rynl10nString(
    key: String,
    args: Map<String, Any?> = emptyMap(),
    locale: String? = null,
): String {
    val state = RynL10n.state
    val version by state.version.collectAsState()
    // version이 remember 키에 들어가야 갱신 시 다시 계산된다(구독 자체도 여기서 성립).
    return remember(key, args, locale, version) { state.t(key, args, locale) }
}
