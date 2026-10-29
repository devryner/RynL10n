package guide.check
import android.app.Application
import androidx.test.core.app.ApplicationProvider
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.assertIsDisplayed
import com.rynl10n.RynL10n
import kotlinx.coroutines.runBlocking
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], application = App::class)
class ComposeGuideTest {
 @get:Rule val compose = createComposeRule()
 @Test fun composeTextsUpdate() {
  val app = ApplicationProvider.getApplicationContext<Application>()
  RynL10n.configure(app, project = "myapp", endpoint = "__CDN__", appVersion = "1.0.0", locale = "en")
  compose.setContent { CatalogText(2) }
  compose.onNodeWithText("Home").assertIsDisplayed()
  compose.onNodeWithText("2 items").assertIsDisplayed()
  runBlocking { RynL10n.update() }
  compose.waitForIdle()
  compose.onNodeWithText("Updated Home").assertIsDisplayed()
  RynL10n.reset()
 }
}
