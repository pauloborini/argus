package com.example.app

import foo.Bar as Baz
import foo.*
import kotlin.collections.List

interface Repo {
  fun load(): String
}

object Singleton {
  val count: Int = 0
  fun bump() {}
}

enum class Status { ACTIVE, INACTIVE }

typealias Handler = (String) -> Unit

class A : Base(), Repo, Serializable {
  val id: Int = 1
  var name: String = ""

  constructor(x: Int) : this() { }

  fun f() {}

  operator fun plus(other: A): A = other

  companion object Factory {
    fun create(): A = A()
  }
}

fun String.extension() {}

val topLevel = 1
