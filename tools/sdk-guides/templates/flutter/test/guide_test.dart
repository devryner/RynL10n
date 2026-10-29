import 'dart:io';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path_provider_platform_interface/path_provider_platform_interface.dart';
import 'package:rynl10n/rynl10n.dart';
import 'package:sdk_guide_check/client.dart';
import 'package:sdk_guide_check/io.dart';
import 'package:sdk_guide_check/automation.dart';

class TestPaths extends PathProviderPlatform {
  final String path;
  TestPaths(this.path);
  @override
  Future<String?> getApplicationCachePath() async => path;
}

void main() {
 TestWidgetsFlutterBinding.ensureInitialized();
 HttpOverrides.global = null;
 final dir = Directory.systemTemp.createTempSync('guide-cache-');
 PathProviderPlatform.instance = TestPaths(dir.path);
 tearDownAll(() => dir.deleteSync(recursive: true));
 testWidgets('guide createClient, locale and Text', (tester) async {
  final text = File('assets/rynl10n/snapshot.json').readAsStringSync();
  RynL10nClient? client;
  await tester.pumpWidget(Localizations(locale: const Locale('en'),
    delegates: const [DefaultWidgetsLocalizations.delegate],
    child: Builder(builder: (context) {
      client = createClient(context, text, InMemoryDeliveryStore());
      return Directionality(textDirection: TextDirection.ltr, child: cartTitle(client!));
    })));
  expect(find.text('カート'), findsOneWidget);
  expect(client!.t('cart.items', args: {'n': 2}), '2 items');
 });
 test('guide rootBundle, path_provider cache, IO delivery, polling, push, telemetry', () async {
  final client = await loadClient(locale: 'en', telemetry: 'aggregate');
  final store = client.store as RemoteDeliveryStore;
  await store.update(client);
  expect(client.t('home.title'), 'Updated Home');
  expect(client.t('cart.items', args: {'n': 2}), '2 items');
  final push = automate(store, client);
  final reporter = report(client);
  expect(await reporter.flush(client), isTrue);
  reporter.stop();push.stop();store.stopPolling();
 });
}
