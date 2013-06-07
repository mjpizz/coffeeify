var fs = require('fs');
var path = require('path');
var coffee = require('coffee-script');
var through = require('through');
var convert = require('convert-source-map');
var falafel = require('falafel');

function isCoffee (file) {
    return (/\.((lit)?coffee|coffee\.md)$/).test(file);
}

function isLiterate (file) {
    return (/\.(litcoffee|coffee\.md)$/).test(file);
}

function getExtension (file) {
  var matches = /(\.[^\.\/\\]+)$/.exec(file);
  return matches ? matches[1] : null;
}

function makeCoffeeRequiresExplicit (file, jsData) {

    // Look for `require()` statements in the AST without file extensions.
    // These will need to be resolved to find CoffeeScript files.
    return falafel(jsData, function (node) {
        if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require') {
            var requireArgNode = node.arguments[0];
            var requireArg = requireArgNode.value;
            if (typeof requireArg === 'string' && !getExtension(requireArg)) {

                // Try to resolve the actual file to see if it is CoffeeScript.
                var fullPath = path.resolve(path.join(path.dirname(file), requireArg));
                var modulePath = require.resolve(fullPath);
                var moduleExtension = getExtension(modulePath);

                // If this was requiring a CoffeeScript file, update the require
                // to explicitly include the extension so that browserify
                // will pick it up in its dependency graph.
                if (isCoffee(modulePath)) {
                    requireArgNode.update(JSON.stringify(requireArg + moduleExtension));
                }

            }
        }

    }).toString();
}

function ParseError(error, src, file) {
    /* Creates a ParseError from a CoffeeScript SyntaxError
       modeled after substack's syntax-error module */
    SyntaxError.call(this);

    this.message = error.message;

    this.line = error.location.first_line + 1; // cs linenums are 0-indexed
    this.column = error.location.first_column + 1; // same with columns

    var markerLen = 2 + error.location.last_column - error.location.first_column;
    this.annotated = [
        file + ':' + this.line,
        src.split('\n')[this.line - 1],
        Array(this.column).join(' ') + Array(markerLen).join('^'),
        'ParseError: ' + this.message
    ].join('\n');
}

ParseError.prototype = Object.create(SyntaxError.prototype);

ParseError.prototype.toString = function () {
    return this.annotated;
};

ParseError.prototype.inspect = function () {
    return this.annotated;
};

function compile(file, data, callback) {
    var compiled;
    try {
        compiled = coffee.compile(data, {
            sourceMap: true,
            generatedFile: file,
            inline: true,
            bare: true,
            literate: isLiterate(file)
        });
    } catch (e) {
        var error = e;
        if (e.location) {
            error = new ParseError(e, data, file);
        }
        callback(error);
        return;
    }

    var map = convert.fromJSON(compiled.v3SourceMap);
    map.setProperty('sources', [file]);

    callback(null, compiled.js + '\n' + map.toComment());
}

function coffeeify(file) {

    var data = '', stream = through(write, end);

    return stream;

    function write(buf) {
        data += buf;
    }

    function end() {
        try {

            // Compile CoffeeScript files before transforming
            // any calls to require().
            if (isCoffee(file)) {
              compile(file, data, function(error, result) {
                  if (error) return stream.emit('error', error);
                  try {
                      stream.queue(makeCoffeeRequiresExplicit(file, result));
                      stream.queue(null);
                  } catch (e) {
                      stream.emit('error', e);
                  }
              });

            // For all other files, we still need to transform calls to
            // require() so that they have explicit extensions.
            } else {
              stream.queue(makeCoffeeRequiresExplicit(file, data));
              stream.queue(null);
            }

        } catch (e) {
            stream.emit('error', e);
        }
    }
}

coffeeify.compile = compile;
coffeeify.isCoffee = isCoffee;
coffeeify.isLiterate = isLiterate;

module.exports = coffeeify;
