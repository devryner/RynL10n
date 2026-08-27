package smoke

import com.rynl10n.BakedBundle
import com.rynl10n.InMemoryDeliveryStore
import com.rynl10n.Matching
import com.rynl10n.RynL10nClient
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/**
 * Maven Central 게시본(AAR)을 실 좌표로 받아 t()까지 굴린다.
 * 유닛 테스트(JVM)로 도는 이유는 코어에 Android API 의존이 없기 때문이다(BakedBundle 주석 참조).
 */
class SmokeTest {

    @Test
    fun `게시된 AAR이 소비자 프로젝트에서 동작한다`() {
        val bundle = BakedBundle.snapshot(File("snapshot.json").inputStream(), "snapshot.json")
        val client = RynL10nClient(
            bundle = bundle,
            store = InMemoryDeliveryStore(),
            context = Matching.ClientContext(appVersion = "3.2.1"),
            locale = "en",
        )

        val failures = mutableListOf<Triple<String, String, String>>()
        for (element in Json.parseToJsonElement(File("checks.json").readText()).jsonArray) {
            val c = element.jsonObject
            val name = c.getValue("name").jsonPrimitive.content
            val expect = c.getValue("expect").jsonPrimitive.content
            // 숫자 → 불리언 → 문자열 순. 복수형의 n은 Int로 들어가야 CLDR 카테고리가 맞는다.
            val args = c.getValue("args").jsonObject.mapValues { (_, v) ->
                val p = v.jsonPrimitive
                p.intOrNull ?: p.booleanOrNull ?: p.content
            }
            val got = client.t(
                c.getValue("key").jsonPrimitive.content,
                args,
                c["locale"]?.jsonPrimitive?.contentOrNull,
            )
            val ok = got == expect
            if (!ok) failures += Triple(name, got, expect)
            println("${if (ok) "PASS" else "FAIL"}  $name: \"$got\"${if (ok) "" else " (기대 \"$expect\")"}")
        }
        for ((name, got, expect) in failures) assertEquals(name, expect, got)
    }
}
