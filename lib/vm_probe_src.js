globalThis.__OPS = [];
globalThis.__PROPS = [];
globalThis.__OPSERR = null;

globalThis.__rec = function (obj, key) {
  try {
    var tag = Object.prototype.toString.call(obj);
    if (tag === '[object Uint8Array]' || tag === '[object Array]' || tag === '[object Int32Array]'
      || tag === '[object Float64Array]' || tag === '[object Uint32Array]') return;
    var t;
    try { t = typeof obj[key]; } catch (e) { t = 'THREW'; }
    globalThis.__PROPS.push([tag, String(key), t]);
  } catch (e) {}
};

(function () {
  var RealFunction = globalThis.Function;
  var READ = /=([a-z])\[([a-z])\]/g;

  globalThis.Function = new Proxy(RealFunction, {
    construct: function (target, args) {
      var src = String(args[args.length - 1] || '');
      try { globalThis.__OPS.push(src); } catch (e) {}
      if (src.indexOf('arguments[0]') === 0 || src.indexOf('=arguments[0]') > 0 || /^const [a-z]=arguments\[0\]/.test(src)) {
        var ins = src.replace(READ, function (_m, o, k) {
          return '=(globalThis.__rec(' + o + ',' + k + '),' + o + '[' + k + '])';
        });
        if (ins !== src) {
          try { return Reflect.construct(target, [ins]); }
          catch (err) { try { globalThis.__OPSERR = [String(err), ins]; } catch (e2) {} }
        }
      }
      return Reflect.construct(target, args);
    },
    apply: function (target, thisArg, args) {
      try { globalThis.__OPS.push(String(args[args.length - 1] || '')); } catch (e) {}
      return Reflect.apply(target, thisArg, args);
    },
  });
})();
