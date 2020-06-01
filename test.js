var pako = require("pako");
var fs = require("fs");

// Deflate
//
var input = fs.readFileSync("./test.txt");
console.log(input, input);
//... fill input data here
var output = pako.deflate(input);
console.log(output);
fs.writeFileSync("./test.txt.compress", output);

output = pako.inflate(output);
console.log(output);