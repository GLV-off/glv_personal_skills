#!/usr/bin/env perl
# check-wiki.pl — валидатор Confluence Wiki Markup (.txt)
# Использование: perl check-wiki.pl article.txt
# Код возврата: 0 — PASS, 1 — FAIL.
use strict;
use warnings;

my $file = shift or die "usage: $0 FILE\n";
open my $fh, '<:raw', $file or die "cannot read $file: $!\n";
local $/;
my $raw = <$fh>;
close $fh;

my (@fail, @warn);

push @fail, 'BOM в начале файла (нужен UTF-8 без BOM)' if substr($raw, 0, 3) eq "\xEF\xBB\xBF";
push @fail, 'CRLF не найден (для .txt по регламенту нужен CRLF)' unless $raw =~ /\r\n/;
push @fail, 'найден LF без CRLF (смешанные окончания строк)' if $raw =~ /(?<!\r)\n/;

my $t = $raw;
$t =~ s/\r\n/\n/g;

push @fail, 'h1. в тексте: заголовок статьи — это title страницы, начните с h2.' if $t =~ /^h1\. /m;

my $open  = () = $t =~ /\{\{/g;
my $close = () = $t =~ /\}\}/g;
push @fail, "несбалансированные {{ }}: open=$open, close=$close" if $open != $close;

my $code_o = () = $t =~ /\{code:/g;
my $code_c = () = $t =~ /\{code\}/g;
push @fail, "несбалансированные {code}: open=$code_o, close=$code_c" if $code_o != $code_c;

my $exp_o = () = $t =~ /\{expand:/g;
my $exp_c = () = $t =~ /\{expand\}/g;
push @fail, "несбалансированные {expand}: open=$exp_o, close=$exp_c" if $exp_o != $exp_c;

for my $m (qw(note info warning)) {
    my $n = () = $t =~ /\{$m\}/g;
    push @fail, "нечётное число {$m}: $n" if $n % 2;
}

my $rest = $t;
$rest =~ s/\{\{[^}\n]*\}\}//g;
$rest =~ s/\{code(?::[^}\n]*)?\}.*?\{code\}//gs;
$rest =~ s/\{expand:[^}\n]*\}.*?\{expand\}//gs;
$rest =~ s/\{(note|info|warning)\}.*?\{\1\}//gs;
$rest =~ s/\{anchor:[^}\n]*\}//g;
push @fail, 'символы { или } вне {{...}} и вне макросов (риск Unknown macro)' if $rest =~ /[{}]/;

my @lines = split /\n/, $t;
my ($cols, $in_tbl) = (0, 0);
for my $i (0 .. $#lines) {
    my $l = $lines[$i];
    if ($l =~ /^\|\|(.*)\|\|\s*$/) {
        my $r = $1;
        $cols = 1 + (() = $r =~ /\|\|/g);
        $in_tbl = 1;
        next;
    }
    if ($in_tbl && $l =~ /^\|(.*)\|\s*$/) {
        my $r = $1;
        my @cells = split /\|/, $r, -1;
        if (scalar(@cells) != $cols) {
            if ($l =~ /\[[^\]]*\|[^\]]*\]/) {
                push @warn, 'строка ' . ($i + 1) . ': похоже на ссылку с | внутри таблицы — вынесите её из таблицы';
            } else {
                push @fail, 'строка ' . ($i + 1) . ': колонок ' . scalar(@cells) . ', ожидалось ' . $cols;
            }
        }
        next;
    }
    $in_tbl = 0;
}

my $stars_src = $t;
$stars_src =~ s/\{code(?::[^}\n]*)?\}.*?\{code\}//gs;
$stars_src =~ s/^\*+ //mg;
my $stars = () = $stars_src =~ /\*/g;
push @warn, "нечётное число * ($stars): возможен незакрытый жирный шрифт" if $stars % 2;

if (@fail) {
    print "FAIL: $file\n";
    print "  - $_\n" for @fail;
    print "  WARN: $_\n" for @warn;
    exit 1;
}
print "PASS: $file\n";
print "  WARN: $_\n" for @warn;
exit 0;
