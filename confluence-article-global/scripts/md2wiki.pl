#!/usr/bin/env perl
# md2wiki.pl — Markdown → Confluence Wiki Markup
# Использование:
#   perl md2wiki.pl --in article.md --out article.txt [--drop-first-h1] [--base 3] [--no-crlf]
# По умолчанию: base=2 (# → h2.), CRLF, UTF-8 без BOM.
use strict;
use warnings;
use Getopt::Long qw(GetOptions);

my %opt = (in => '-', out => '-', base => 2, 'drop-first-h1' => 0, crlf => 1);
GetOptions(\%opt, 'in=s', 'out=s', 'base=i', 'drop-first-h1', 'crlf!')
  or die "usage: $0 --in FILE --out FILE [--drop-first-h1] [--base N] [--no-crlf]\n";
$opt{base} = 2 if $opt{base} < 2;
$opt{base} = 6 if $opt{base} > 6;

my $doc;
if ($opt{in} eq '-') {
    local $/;
    $doc = <STDIN>;
} else {
    open my $fh, '<:encoding(UTF-8)', $opt{in} or die "cannot read $opt{in}: $!\n";
    local $/;
    $doc = <$fh>;
    close $fh;
}
$doc = '' unless defined $doc;
$doc =~ s/\r\n/\n/g;
$doc =~ s/\r/\n/g;

my @lines = split /\n/, $doc;
my (@out, @tbl);
my $in_code = 0;
my $h1_seen = 0;

sub esc {
    my ($x) = @_;
    $x =~ s/#/&#35;/g;
    $x =~ s/\*/&#42;/g;
    $x =~ s/\[/&#91;/g;
    $x =~ s/\]/&#93;/g;
    return $x;
}

sub mdlink {
    my ($t, $u) = @_;
    return "[$t|page:$1]" if $u =~ /[?&]pageId=(\d+)/;
    return "[$t|$u]"     if $u =~ m{^https?://};
    return "[$t|#$1]"    if $u =~ /^#(.+)$/;
    return "[$t|^$u]";
}

sub mdimg {
    my ($alt, $u) = @_;
    return $alt ne '' ? "!$alt|$u!" : "!$u!" if $u =~ m{^https?://};
    return "!^$u!";
}

sub inline {
    my ($s) = @_;
    $s =~ s/!\[([^\]]*)\]\(([^)\s]+)\)/mdimg($1, $2)/ge;
    $s =~ s/\[([^\]]+)\]\(([^)\s]+)\)/mdlink($1, $2)/ge;
    $s =~ s/\*\*(.+?)\*\*/'*' . $1 . '*'/ge;
    $s =~ s/`([^`]+)`/'{{' . esc($1) . '}}'/ge;
    return $s;
}

sub tblrow {
    my ($r, $d) = @_;
    $r =~ s/^\s*\|//;
    $r =~ s/\|\s*$//;
    my @c = map { my $x = inline($_); $x =~ s/^\s+|\s+$//g; $x } split /\s*\|\s*/, $r, -1;
    return $d . ' ' . join(' ' . $d . ' ', @c) . ' ' . $d;
}

sub flush_tbl {
    return unless @tbl;
    my $sep = -1;
    for my $i (0 .. $#tbl) {
        if ($tbl[$i] =~ /^\|[\s\-:|]+\|?\s*$/) { $sep = $i; last; }
    }
    my @head = $sep > 0 ? @tbl[0 .. $sep - 1] : ();
    my @body = $sep >= 0 ? @tbl[$sep + 1 .. $#tbl] : @tbl;
    push @out, tblrow($_, '||') for @head;
    push @out, tblrow($_, '|')  for @body;
    @tbl = ();
}

for my $line (@lines) {
    if ($line =~ /^```(\w*)\s*$/) {
        if (!$in_code) {
            my $lang = $1 eq '' ? 'text' : $1;
            push @out, '{code:language=' . $lang . '}';
            $in_code = 1;
        } else {
            push @out, '{code}';
            $in_code = 0;
        }
        next;
    }
    if ($in_code) { push @out, $line; next; }

    if ($line =~ /^\|/) { push @tbl, $line; next; }
    flush_tbl();

    if ($line =~ /^(#{1,6})\s+(.*)$/) {
        my ($hashes, $text) = ($1, $2);
        if (length($hashes) == 1) {
            $h1_seen++;
            next if $opt{'drop-first-h1'} && $h1_seen == 1;
        }
        my $shift = $opt{'drop-first-h1'} ? -1 : 0;
        my $lvl = length($hashes) - 1 + $opt{base} + $shift;
        $lvl = 2 if $lvl < 2;
        $lvl = 6 if $lvl > 6;
        push @out, "h$lvl. " . inline($text);
        next;
    }

    if ($line =~ /^---+\s*$/) { push @out, '----'; next; }

    if ($line =~ /^(\s*)[-*]\s+(.*)$/) {
        my $lvl = int(length($1) / 2);
        push @out, ('*' x ($lvl + 1)) . ' ' . inline($2);
        next;
    }
    if ($line =~ /^(\s*)\d+\.\s+(.*)$/) {
        my $lvl = int(length($1) / 2);
        push @out, ('#' x ($lvl + 1)) . ' ' . inline($2);
        next;
    }

    $line =~ s{<details>\s*<summary>(.*?)</summary>}{'{expand:' . $1 . '}'}ge;
    $line =~ s{</details>}{'{expand}'}ge;

    push @out, inline($line);
}
flush_tbl();

shift @out while @out && $out[0] eq '';
my $result = join("\n", @out) . "\n";
$result =~ s/\n/\r\n/g if $opt{crlf};

if ($opt{out} eq '-') {
    print $result;
} else {
    open my $of, '>:encoding(UTF-8)', $opt{out} or die "cannot write $opt{out}: $!\n";
    print $of $result;
    close $of;
}
exit 0;
