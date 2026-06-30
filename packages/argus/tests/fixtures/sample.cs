using System;
using static System.Math;
global using System.Collections.Generic;
using Alias = System.Text.StringBuilder;

namespace MyApp.Models
{
    public class Person : BaseEntity, ISerializable
    {
        public string Name { get; set; }
        private int _age;
        public event EventHandler Changed;

        public Person(string name) { Name = name; }

        public void Greet()
        {
            Console.WriteLine(Name);
            var list = new List<int>();
        }

        public class Inner
        {
            public void InnerMethod() { }
        }
    }

    public struct Point
    {
        public int X;
        public int Y;
    }

    public record Order(int Id, string Item);

    public record struct Measurement(double Value, string Unit) : IComparable;

    public interface IRepo : IDisposable
    {
        void Save();
        string Label { get; }
    }

    public enum Status
    {
        Active,
        Inactive
    }

    public delegate void Handler(object sender);
}
