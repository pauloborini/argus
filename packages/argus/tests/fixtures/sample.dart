import 'dart:io';
part 'sample_part.dart';

typedef IntCallback = void Function(int value);

const double kPadding = 8.0;
final config = AppConfig();

enum Status { active, inactive }

mixin Disposable on Base {
  void dispose() {}
}

class A extends B with Disposable implements C {
  final String name;
  int count = 0;

  A(this.name);
  A.named({required this.name});
  factory A.create() => A('default');

  void m() {}
  void build() {
    final list = <int>[];
    list..add(1)..remove(2);
  }
}
