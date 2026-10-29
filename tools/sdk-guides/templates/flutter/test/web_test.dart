@TestOn('browser')
library;
import 'package:flutter_test/flutter_test.dart';
import 'package:rynl10n/rynl10n.dart';
import 'package:web/web.dart' as web;
import 'package:sdk_guide_check/web.dart' as guide;
void main() {
 test('guide package:http and scoped localStorage cache', () async {
  web.window.localStorage.setItem('unrelated-key', 'keep');
  final manifest = await guide.store.loadManifest();
  final client = RynL10nClient(bundle: await guide.store.fetchSnapshot(manifest.releases.first.snapshot),
    store: guide.store, context: ClientContext(appVersion: '3.2.1'), telemetry: 'aggregate');
  await guide.store.update(client);
  expect(client.t('home.title'), 'Updated Home');
  expect(web.window.localStorage.length, greaterThan(1));
  guide.store.clearCache();
  expect(web.window.localStorage.getItem('unrelated-key'), 'keep');
  expect(web.window.localStorage.length, 1);
  web.window.localStorage.removeItem('unrelated-key');
 });
}
