package pairing

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"math"
	"sort"
	"unicode/utf8"
)

const MaxCBORBytes = 2048

func encodeHead(major byte, value uint64) []byte {
	switch {
	case value < 24:
		return []byte{major<<5 | byte(value)}
	case value <= math.MaxUint8:
		return []byte{major<<5 | 24, byte(value)}
	case value <= math.MaxUint16:
		encoded := make([]byte, 3)
		encoded[0] = major<<5 | 25
		binary.BigEndian.PutUint16(encoded[1:], uint16(value))
		return encoded
	case value <= math.MaxUint32:
		encoded := make([]byte, 5)
		encoded[0] = major<<5 | 26
		binary.BigEndian.PutUint32(encoded[1:], uint32(value))
		return encoded
	default:
		encoded := make([]byte, 9)
		encoded[0] = major<<5 | 27
		binary.BigEndian.PutUint64(encoded[1:], value)
		return encoded
	}
}

func compareKeys(left, right []byte) int {
	if len(left) != len(right) {
		return len(left) - len(right)
	}
	return bytes.Compare(left, right)
}

func EncodeCanonicalCBOR(value any) ([]byte, error) {
	switch typed := value.(type) {
	case uint64:
		return encodeHead(0, typed), nil
	case uint:
		return encodeHead(0, uint64(typed)), nil
	case int:
		if typed < 0 {
			return nil, fmt.Errorf("negative canonical CBOR integer")
		}
		return encodeHead(0, uint64(typed)), nil
	case []byte:
		return append(encodeHead(2, uint64(len(typed))), typed...), nil
	case string:
		if !utf8.ValidString(typed) {
			return nil, fmt.Errorf("invalid UTF-8 CBOR text")
		}
		return append(encodeHead(3, uint64(len([]byte(typed)))), []byte(typed)...), nil
	case []string:
		values := make([]any, len(typed))
		for index := range typed {
			values[index] = typed[index]
		}
		return EncodeCanonicalCBOR(values)
	case []any:
		output := encodeHead(4, uint64(len(typed)))
		for _, item := range typed {
			encoded, err := EncodeCanonicalCBOR(item)
			if err != nil {
				return nil, err
			}
			output = append(output, encoded...)
		}
		return output, nil
	case map[uint64]any:
		type entry struct {
			key   []byte
			value []byte
		}
		entries := make([]entry, 0, len(typed))
		for key, value := range typed {
			encodedValue, err := EncodeCanonicalCBOR(value)
			if err != nil {
				return nil, err
			}
			entries = append(entries, entry{key: encodeHead(0, key), value: encodedValue})
		}
		sort.Slice(entries, func(i, j int) bool {
			return compareKeys(entries[i].key, entries[j].key) < 0
		})
		output := encodeHead(5, uint64(len(entries)))
		for _, entry := range entries {
			output = append(output, entry.key...)
			output = append(output, entry.value...)
		}
		return output, nil
	default:
		return nil, fmt.Errorf("unsupported canonical CBOR type %T", value)
	}
}

type cborDecoder struct {
	encoded []byte
	offset  int
	items   int
}

func (d *cborDecoder) read(length int) ([]byte, error) {
	if length < 0 || d.offset+length > len(d.encoded) {
		return nil, fmt.Errorf("truncated canonical CBOR")
	}
	value := d.encoded[d.offset : d.offset+length]
	d.offset += length
	return value, nil
}

func (d *cborDecoder) readLength(additional byte) (uint64, error) {
	if additional < 24 {
		return uint64(additional), nil
	}
	switch additional {
	case 24:
		encoded, err := d.read(1)
		if err != nil {
			return 0, err
		}
		value := uint64(encoded[0])
		if value < 24 {
			return 0, fmt.Errorf("non-shortest CBOR integer or length")
		}
		return value, nil
	case 25:
		encoded, err := d.read(2)
		if err != nil {
			return 0, err
		}
		value := uint64(binary.BigEndian.Uint16(encoded))
		if value <= math.MaxUint8 {
			return 0, fmt.Errorf("non-shortest CBOR integer or length")
		}
		return value, nil
	case 26:
		encoded, err := d.read(4)
		if err != nil {
			return 0, err
		}
		value := uint64(binary.BigEndian.Uint32(encoded))
		if value <= math.MaxUint16 {
			return 0, fmt.Errorf("non-shortest CBOR integer or length")
		}
		return value, nil
	case 27:
		encoded, err := d.read(8)
		if err != nil {
			return 0, err
		}
		value := binary.BigEndian.Uint64(encoded)
		if value <= math.MaxUint32 {
			return 0, fmt.Errorf("non-shortest CBOR integer or length")
		}
		return value, nil
	default:
		return 0, fmt.Errorf("indefinite or reserved CBOR length")
	}
}

func (d *cborDecoder) length(value uint64) (int, error) {
	if value > uint64(len(d.encoded)) {
		return 0, fmt.Errorf("CBOR length exceeds input bound")
	}
	return int(value), nil
}

func (d *cborDecoder) value(depth int) (any, error) {
	d.items++
	if depth > 16 || d.items > 512 {
		return nil, fmt.Errorf("CBOR nesting or item count exceeds bound")
	}
	initialBytes, err := d.read(1)
	if err != nil {
		return nil, err
	}
	initial := initialBytes[0]
	major := initial >> 5
	value, err := d.readLength(initial & 0x1f)
	if err != nil {
		return nil, err
	}
	switch major {
	case 0:
		return value, nil
	case 2:
		length, err := d.length(value)
		if err != nil {
			return nil, err
		}
		encoded, err := d.read(length)
		return append([]byte(nil), encoded...), err
	case 3:
		length, err := d.length(value)
		if err != nil {
			return nil, err
		}
		encoded, err := d.read(length)
		if err != nil {
			return nil, err
		}
		if !utf8.Valid(encoded) {
			return nil, fmt.Errorf("invalid UTF-8 CBOR text")
		}
		return string(encoded), nil
	case 4:
		length, err := d.length(value)
		if err != nil {
			return nil, err
		}
		result := make([]any, length)
		for index := range result {
			result[index], err = d.value(depth + 1)
			if err != nil {
				return nil, err
			}
		}
		return result, nil
	case 5:
		length, err := d.length(value)
		if err != nil {
			return nil, err
		}
		result := make(map[uint64]any, length)
		var previous []byte
		for index := 0; index < length; index++ {
			keyStart := d.offset
			keyValue, err := d.value(depth + 1)
			if err != nil {
				return nil, err
			}
			key, ok := keyValue.(uint64)
			if !ok {
				return nil, fmt.Errorf("pairing CBOR map key is not unsigned integer")
			}
			encodedKey := d.encoded[keyStart:d.offset]
			if previous != nil && compareKeys(previous, encodedKey) >= 0 {
				return nil, fmt.Errorf("duplicate or reordered CBOR map key")
			}
			if _, exists := result[key]; exists {
				return nil, fmt.Errorf("duplicate CBOR map key")
			}
			previous = encodedKey
			result[key], err = d.value(depth + 1)
			if err != nil {
				return nil, err
			}
		}
		return result, nil
	default:
		return nil, fmt.Errorf("forbidden CBOR major type %d", major)
	}
}

func DecodeCanonicalCBOR(encoded []byte) (any, error) {
	if len(encoded) == 0 || len(encoded) > MaxCBORBytes {
		return nil, fmt.Errorf("canonical CBOR input outside byte bound")
	}
	decoder := &cborDecoder{encoded: encoded}
	value, err := decoder.value(0)
	if err != nil {
		return nil, err
	}
	if decoder.offset != len(encoded) {
		return nil, fmt.Errorf("canonical CBOR has trailing bytes")
	}
	reencoded, err := EncodeCanonicalCBOR(value)
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(reencoded, encoded) {
		return nil, fmt.Errorf("CBOR is not deterministic canonical form")
	}
	return value, nil
}
