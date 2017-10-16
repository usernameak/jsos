// Brainfuck interpreter for JsOS
// Original: https://github.com/skilldrick/brainfuck-js
// Ported by PROPHESSOR

'use strict';

const Brainfuck = require('./interpreter');
let io;

function main(_args, api, res) {
  const args = _args.split(/\s+/);
  io = api.stdio;

  if (!args[0]) {
    io.writeError('You forgot to specify the program');
    return res(1);
  }

  if (args[0] === 'hw') args[0] = '++++++++++[>+++++++>++++++++++>+++>+<<<<-]>++.>+.+++++++..+++.>++.<<+++++++++++++++.>.+++.------.--------.>+.>.';

  io.setColor('yellow');
  io.write(`BF: Starting program ${args[0]} `);
  if (args[1]) io.write(`with data: ${args[1]}`);

//   debugger;
  const bf = new Brainfuck(args[0], args[1]);
  io.setColor('green');
  io.writeLine(bf.parse(args[0])(args[1]));

  return res(0); // 1 = error
}

exports.call = (cmd, args, api, res) => main(args, api, res);

exports.commands = ['example'];
// demo 10+[>7+>10+>3+>+4<-]>2+.>+.7+2.3+.>2+.2<15+.>.3+.6-.8-.>+.>.
