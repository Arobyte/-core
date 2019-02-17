@{%
	var Decimal = require('decimal.js');
	var moo = require("moo");

	var lexer = moo.compile({
		string: [
			{match: /"(?:\\["\\rn]|[\\\rn]|[^"\\])*?"/, lineBreaks: true, value: function(v){
				return v.slice(1, -1).replace(/\\\"/g, '"').replace(/\\\\/g, '\\');
			}},
			{match: /'(?:\\['\\rn]|[\\\rn]|[^'\\])*?'/, lineBreaks: true, value: function(v){
				return v.slice(1, -1).replace(/\\\'/g, "'").replace(/\\\\/g, '\\');
			}}
		],
		WS: {match: /[\s]+/, lineBreaks: true},
		number: /(?:[0-9]|[1-9][0-9]+)(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?\b/,
		op: ["+", "-", "/", "*", '^'],
		concat: '||',
		l: '(',
		r: ')',
		sl:'[',
		sr: ']',
		io: ['input', 'output'],
		data_feed: ['data_feed', 'in_data_feed'],
		comparisonOperators: ["==", ">=", "<=", "!=", ">", "<", "="],
		dfParamsName: ['oracles', 'feed_name', 'min_mci', 'feed_value', 'ifseveral', 'ifnone', 'what'],
		name: ['min', 'max', 'pi', 'e', 'sqrt', 'ceil', 'floor', 'round'],
		and: ['and', 'AND'],
		or: ['or', 'OR'],
		not: ['not', 'NOT', '!'],
		ioParamsName: ['address', 'amount', 'asset'],
		quote: '"',
		ternary: ['?', ':'],
		ioParamValue: ['base', 'this address', 'other address', /\b[2-7A-Z]{32}\b/],
		comma: ',',
		dot: '.',
	});

	var origNext = lexer.next;

    lexer.next = function () {
		var tok = origNext.call(this);
		if (tok) {
			switch (tok.type) {
				case 'WS':
					return lexer.next();
			}
			return tok;
		}
		return undefined;
	};
%}

@lexer lexer

main -> expr {% id %}


ternary_expr -> or_expr "?" expr ":" ternary_expr {% function(d) {return ['ternary', d[0], d[2], d[4]];}%}
	| or_expr {% id %}

or_expr -> or_expr %or and_expr {% function(d) {return ['or', d[0], d[2]];}%}
	| and_expr {% id %}

and_expr -> and_expr %and comp_expr {% function(d) {return ['and', d[0], d[2]];}%}
	| comp_expr {% id %}

expr -> ternary_expr {% id %}

expr_list -> expr ("," expr):*  {% function(d) { return [d[0]].concat(d[1].map(function (item) {return item[1];}));   } %}


comp_expr -> AS comparisonOperator AS {% function(d) {return ['comparison', d[1], d[0], d[2]];}%}
	| AS {% id %}

comparisonOperator -> %comparisonOperators {% function(d) { return d[0].value } %}


df_param ->  %dfParamsName comparisonOperator expr  {% function(d) { return [d[0].value, d[1], d[2]]; } %}
df_param_list -> df_param ("," df_param):*  {% function(d) { return [d[0]].concat(d[1].map(function (item) {return item[1];}));   } %}

io_param ->  %ioParamsName comparisonOperator (expr|%ioParamValue)  {% function(d) {
		var value = d[2][0];
		if (value.type === 'ioParamValue')
			value = value.value;
		return [d[0].value, d[1], value];
	} %}
io_param_list -> io_param ("," io_param):*  {% function(d) { return [d[0]].concat(d[1].map(function (item) {return item[1];}));   } %}


P -> %l expr %r {% function(d) {return d[1]; } %}
    | N      {% id %}
	| string {% id %}

Exp -> P "^" Exp    {% function(d) {return ['^', d[0], d[2]]; } %}
    | P             {% id %}

unary_expr -> Exp {% id %}
	| %not Exp {% function(d) {return ['not', d[1]];}%}

MD -> MD "*" unary_expr  {% function(d) {return ['*', d[0], d[2]]; } %}
    | MD "/" unary_expr  {% function(d) {return ['/', d[0], d[2]]; } %}
    | unary_expr             {% id %}

AS -> AS "+" MD {% function(d) {return ['+', d[0], d[2]]; } %}
    | AS "-" MD {% function(d) {return ['-', d[0], d[2]]; } %}
    | "-" MD {% function(d) {return ['-', new Decimal(0), d[1]]; } %}
    | AS %concat MD {% function(d) {return ['concat', d[0], d[2]]; } %}
    | MD            {% id %}

N -> float          {% id %}
    | "pi"          {% function(d) {return ['pi']; } %}
    | "e"           {% function(d) {return ['e']; } %}
    | "sqrt" %l AS %r    {% function(d) {return ['sqrt', d[2]]; } %}
    | "min" %l expr_list %r  {% function(d) {return ['min', d[2]]; }  %}
    | "max" %l expr_list %r  {% function(d) {return ['max', d[2]]; }  %}
    | "ceil" %l AS (%comma AS):? %r    {% function(d) {return ['ceil', d[2], d[3] ? d[3][1] : null]; } %}
    | "floor" %l AS (%comma AS):? %r    {% function(d) {return ['floor', d[2], d[3] ? d[3][1] : null]; } %}
    | "round" %l AS (%comma AS):? %r    {% function(d) {return ['round', d[2], d[3] ? d[3][1] : null]; } %}
    | %data_feed %sl df_param_list %sr {% function (d, location, reject){
		var params = {};
		var arrParams = d[2];
		for(var i = 0; i < arrParams.length; i++){
			var name = arrParams[i][0];
			var operator = arrParams[i][1];
			var value = arrParams[i][2];
			if(params[name]) return reject;
			params[name] = {operator: operator, value: value};
		}
		return [d[0].value, params]
	}%}
    | (%io %sl io_param_list %sr ) %dot %ioParamsName {% function (d, location, reject){
		var params = {};
		var arrParams = d[0][2];
		for(var i = 0; i < arrParams.length; i++){
			var name = arrParams[i][0];
			var operator = arrParams[i][1];
			var value = arrParams[i][2];
			if(params[name]) return reject;
			params[name] = {operator: operator, value: value};
		}
		return [d[0][0].value, params, d[2].value]
	}%}

float -> %number           {% function(d) { debugger; return new Decimal(d[0].value); }%}

string -> %string        {% function(d) {return d[0].value; } %}