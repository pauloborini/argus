import 'dart:io';

typedef IntCallback = void Function(int value);

const double kPadding = 8.0;
final config = AppConfig();

mixin Disposable on Base {
  void dispose() {}
}

class A extends B with Disposable implements C {
  void m() {}
}
