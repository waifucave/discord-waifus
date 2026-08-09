# Waifus SAS Wordlist V1

`sas-v1.txt` is the immutable word-to-index authority for pairing protocol V1. Each file line is
one zero-based index: line 1 is index 0 and line 1,024 is index 1,023. The file is ASCII,
LF-terminated, and contains exactly 1,024 unique lowercase words of four or five letters. The
first four letters are also unique so the comparison UI may emphasize or accept that prefix
without creating ambiguity.

## Source and attribution

The checked-in source snapshot at `source/eff-short-wordlist-1.txt` is the Electronic Frontier
Foundation's **EFF Short Wordlist 1**, published at:

https://www.eff.org/files/2016/09/08/eff_short_wordlist_1.txt

- Source SHA-256: `8f5ca830b8bffb6fe39c9736c024a00a6a6411adb3f83a9be8bfeeb6e067ae69`
- Source entries: 1,296
- Copyright: Electronic Frontier Foundation
- License: [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/)
- EFF copyright policy: https://www.eff.org/copyright

WaifuCave adapted that list by removing 272 entries and assigning new zero-based indices to the
remaining words in their original source order. EFF does not endorse this adaptation.

## Reviewed adaptation

`sas-v1-denylist.tsv` records every excluded source word and one stable reason code:

| Reason | Count | Rule |
| --- | ---: | --- |
| `too_short` | 82 | Fewer than four letters. |
| `non_lowercase_ascii_letters` | 1 | Contains a character outside `a-z`. |
| `shared_first_four` | 77 | Shares its first four letters with another retained candidate. |
| `manual_safety_or_clarity` | 89 | Reviewed as unsuitable for a calm, clear comparison prompt. |
| `inflected_or_plural` | 23 | Reviewed inflection or plural that weakens spoken distinction. |

The 1,296 source entries therefore partition exactly into 1,024 retained entries and 272 reviewed
exclusions. Regeneration rejects any source-byte, ordering, count, character, duplicate, prefix,
or accounting drift.

## Protocol mapping

The pairing derivation produces 50 comparison bits. Read them as five consecutive 10-bit groups,
most-significant group first. Interpret each group as an unsigned integer from 0 through 1,023 and
look up the word at that zero-based index in `sas-v1.txt`. Implementations must not sort, normalize,
translate, or substitute words.

- Derived wordlist SHA-256: `75282c58b95c5c9b54f8b570a74bf85e1ffd78bd7d44973a82c7aebadb813874`
- Index width: 10 bits
- Word count: 1,024
- Comparison length: five words

Any addition, removal, reordering, spelling change, or mapping change requires a new
pairing-protocol major version. A patch or minor release must retain these exact bytes.

Run `npm run contracts:sas:generate` to reproduce the derived TypeScript, Go, denylist, and text
artifacts from the checked-in source snapshot. Run `npm run contracts:sas:check` to verify them
without network access.
