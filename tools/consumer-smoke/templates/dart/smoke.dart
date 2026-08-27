// 게시본을 pub 캐시에서 그대로 import 한다 — 경로 의존(path:)이 하나도 없어야 한다.
import 'dart:convert';
import 'dart:io';

import 'package:rynl10n/rynl10n.dart';

void main() {
  final bundle = parseBakedSnapshot(File('snapshot.json').readAsStringSync(),
      source: 'snapshot.json');
  final client = RynL10nClient(
    bundle: bundle,
    store: InMemoryDeliveryStore(),
    context: ClientContext(appVersion: '3.2.1'),
    locale: 'en',
  );

  var bad = 0;
  final checks = jsonDecode(File('checks.json').readAsStringSync()) as List<dynamic>;
  for (final raw in checks) {
    final c = raw as Map<String, dynamic>;
    final got = client.t(
      c['key'] as String,
      args: (c['args'] as Map<String, dynamic>).cast<String, Object?>(),
      locale: c['locale'] as String?,
    );
    final ok = got == c['expect'];
    if (!ok) bad++;
    stdout.writeln('${ok ? "PASS" : "FAIL"}  ${c['name']}: "$got"'
        '${ok ? "" : ' (기대 "${c['expect']}")'}');
  }
  exitCode = bad == 0 ? 0 : 1;
}
