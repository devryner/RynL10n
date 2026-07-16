package com.rynl10n

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Compose/StateFlow 바인딩 — 기획서 6.2.
 * 카탈로그 갱신 시 [version]이 증가한다. Compose에서 `val v by state.version.collectAsState()`로
 * 구독하면 갱신 시 리컴포지션 → `state.t("key")`가 최신 값을 반환한다.
 * (Compose `stringResource` 대응 어댑터는 Compose 런타임 의존 → 앱 모듈에서 얇게 감싼다.)
 */
class RynL10nState(val client: RynL10nClient) {
    private val _version = MutableStateFlow(0)
    val version: StateFlow<Int> = _version.asStateFlow()

    init {
        client.onCatalogUpdated { _version.value = _version.value + 1 }
    }

    fun t(key: String, args: Map<String, Any?> = emptyMap(), locale: String? = null): String =
        client.t(key, args, locale)

    fun refresh(manifest: Manifest): Boolean = client.refresh(manifest)
}
