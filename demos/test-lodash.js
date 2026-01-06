const _ = require('lodash');

const arr = [1, 2, 3, 4, 5];
const chunked = _.chunk(arr, 2);

console.log("Original:", arr);
console.log("Lodash Chunked:", JSON.stringify(chunked));