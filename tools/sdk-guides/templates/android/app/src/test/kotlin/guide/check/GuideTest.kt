package guide.check
import android.app.Application
import android.widget.TextView
import androidx.test.core.app.ApplicationProvider
import com.rynl10n.*
import kotlinx.coroutines.runBlocking
import org.junit.Test
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], application = App::class)
class GuideTest {
 @Test fun guideRuntime() = runBlocking {
  val app = ApplicationProvider.getApplicationContext<Application>()
  assertEquals("Home", RynL10n.t("home.title", locale = "en"))
  assertEquals("2 items", RynL10n.t("cart.items", mapOf("n" to 2), locale = "en"))
  val tv = TextView(app)
  fragments(app, tv, 2)
  RynL10n.disconnectServerPush(); RynL10n.stopPolling()
  assertEquals(app.rynl10n("home.title"), tv.text.toString())
  RynL10n.configure(app, project = "myapp", endpoint = "__CDN__", appVersion = "1.0.0", locale = "en", telemetry = "aggregate")
  assertTrue(RynL10n.update())
  assertEquals("Updated Home", RynL10n.t("home.title"))
  RynL10n.startPolling();RynL10n.stopPolling()
  RynL10n.connectServerPush("__API__");RynL10n.disconnectServerPush()
  RynL10n.startTelemetry("__API__"); assertTrue(RynL10n.flushTelemetry());RynL10n.stopTelemetry()
  RynL10n.reset()
 }
}
