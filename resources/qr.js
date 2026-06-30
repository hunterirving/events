// Self-contained QR encoder (byte mode, EC level M, versions 1-40).
// createMatrix(text) returns a square matrix[row][col] of 0/1 modules

(function () {
	// Galois Field tables for Reed-Solomon
	var GF_EXP = new Array(512);
	var GF_LOG = new Array(256);

	(function initGF() {
		var x = 1;
		for (var i = 0; i < 255; i++) {
			GF_EXP[i] = x;
			GF_LOG[x] = i;
			x <<= 1;
			if (x & 0x100) x ^= 0x11d;
		}
		for (var j = 255; j < 512; j++) {
			GF_EXP[j] = GF_EXP[j - 255];
		}
	})();

	function gfMul(a, b) {
		if (a === 0 || b === 0) return 0;
		return GF_EXP[GF_LOG[a] + GF_LOG[b]];
	}

	// Alignment pattern positions lookup table (from QR spec)
	var ALIGNMENT_POSITIONS = [
		null,
		[],
		[6, 18],
		[6, 22],
		[6, 26],
		[6, 30],
		[6, 34],
		[6, 22, 38],
		[6, 24, 42],
		[6, 26, 46],
		[6, 28, 50],
		[6, 30, 54],
		[6, 32, 58],
		[6, 34, 62],
		[6, 26, 46, 66],
		[6, 26, 48, 70],
		[6, 26, 50, 74],
		[6, 30, 54, 78],
		[6, 30, 56, 82],
		[6, 30, 58, 86],
		[6, 34, 62, 90],
		[6, 28, 50, 72, 94],
		[6, 26, 50, 74, 98],
		[6, 30, 54, 78, 102],
		[6, 28, 54, 80, 106],
		[6, 32, 58, 84, 110],
		[6, 30, 58, 86, 114],
		[6, 34, 62, 90, 118],
		[6, 26, 50, 74, 98, 122],
		[6, 30, 54, 78, 102, 126],
		[6, 26, 52, 78, 104, 130],
		[6, 30, 56, 82, 108, 134],
		[6, 34, 60, 86, 112, 138],
		[6, 30, 58, 86, 114, 142],
		[6, 34, 62, 90, 118, 146],
		[6, 30, 54, 78, 102, 126, 150],
		[6, 24, 50, 76, 102, 128, 154],
		[6, 28, 54, 80, 106, 132, 158],
		[6, 32, 58, 84, 110, 136, 162],
		[6, 26, 54, 82, 110, 138, 166],
		[6, 30, 58, 86, 114, 142, 170]
	];

	// EC_TABLE: [totalDataCodewords, ecPerBlock, group1Blocks, group1Data, group2Blocks, group2Data]
	var EC_TABLE = [
		null,
		[16, 10, 1, 16, 0, 0],     // V1
		[28, 16, 1, 28, 0, 0],     // V2
		[44, 26, 1, 44, 0, 0],     // V3
		[64, 18, 2, 32, 0, 0],     // V4
		[86, 24, 2, 43, 0, 0],     // V5
		[108, 16, 4, 27, 0, 0],    // V6
		[124, 18, 4, 31, 0, 0],    // V7
		[154, 22, 2, 38, 2, 39],   // V8
		[182, 22, 3, 36, 2, 37],   // V9
		[216, 26, 4, 43, 1, 44],   // V10
		[254, 30, 1, 50, 4, 51],   // V11
		[290, 22, 6, 36, 2, 37],   // V12
		[334, 22, 8, 37, 1, 38],   // V13
		[365, 24, 4, 40, 5, 41],   // V14
		[415, 24, 5, 41, 5, 42],   // V15
		[453, 28, 7, 45, 3, 46],   // V16
		[507, 28, 10, 46, 1, 47],  // V17
		[563, 26, 9, 43, 4, 44],   // V18
		[627, 26, 3, 44, 11, 45],  // V19
		[669, 26, 3, 41, 13, 42],  // V20
		[714, 26, 17, 42, 0, 0],   // V21
		[782, 28, 17, 46, 0, 0],   // V22
		[860, 28, 4, 47, 14, 48],  // V23
		[914, 28, 6, 45, 14, 46],  // V24
		[1000, 28, 8, 47, 13, 48], // V25
		[1062, 28, 19, 46, 4, 47], // V26
		[1128, 28, 22, 45, 3, 46], // V27
		[1193, 28, 3, 45, 23, 46], // V28
		[1267, 28, 21, 45, 7, 46], // V29
		[1373, 28, 19, 47, 10, 48],// V30
		[1455, 28, 2, 46, 29, 47], // V31
		[1541, 28, 10, 46, 23, 47],// V32
		[1631, 28, 14, 46, 21, 47],// V33
		[1725, 28, 14, 46, 23, 47],// V34
		[1812, 28, 12, 47, 26, 48],// V35
		[1914, 28, 6, 47, 34, 48], // V36
		[1992, 28, 29, 46, 14, 47],// V37
		[2102, 28, 13, 46, 32, 47],// V38
		[2216, 28, 40, 47, 7, 48], // V39
		[2334, 28, 18, 47, 31, 48] // V40
	];

	function getVersion(byteLength) {
		for (var v = 1; v <= 40; v++) {
			var charCountBits = v <= 9 ? 8 : 16;
			var dataBits = 4 + charCountBits + byteLength * 8;
			var dataBytes = Math.ceil(dataBits / 8);
			if (dataBytes <= EC_TABLE[v][0]) return v;
		}
		return 40;
	}

	function createQR(text) {
		var bytes = new TextEncoder().encode(text);
		var version = getVersion(bytes.length);
		var size = version * 4 + 17;
		var matrix = Array.from({ length: size }, function () { return Array(size).fill(null); });

		addFinderPatterns(matrix, size);
		addSeparators(matrix, size);
		addTimingPatterns(matrix, size);
		addAlignmentPatterns(matrix, version, size);
		addDarkModule(matrix, version);

		reserveFormatAreas(matrix, size);
		if (version >= 7) reserveVersionAreas(matrix, size);

		var reserved = createReservedMap(matrix, size);

		var data = encodeData(bytes, version);
		var ecData = addErrorCorrection(data, version);
		placeData(matrix, ecData, size);

		var mask = applyBestMask(matrix, size, reserved);
		addFormatInfo(matrix, size, mask);
		if (version >= 7) addVersionInfo(matrix, version);

		return matrix;
	}

	// Finder pattern: 7x7 with specific structure
	// Outer black border, inner white border, center 3x3 black
	function addFinderPatterns(matrix, size) {
		var positions = [
			[0, 0],           // top-left
			[0, size - 7],    // top-right
			[size - 7, 0]     // bottom-left
		];

		for (var p = 0; p < positions.length; p++) {
			var startRow = positions[p][0], startCol = positions[p][1];
			for (var r = 0; r < 7; r++) {
				for (var c = 0; c < 7; c++) {
					var isBlack;
					if (r === 0 || r === 6 || c === 0 || c === 6) {
						isBlack = true; // outer border
					} else if (r === 1 || r === 5 || c === 1 || c === 5) {
						isBlack = false; // inner white border
					} else {
						isBlack = true; // center 3x3
					}
					matrix[startRow + r][startCol + c] = isBlack ? 1 : 0;
				}
			}
		}
	}

	// Separators: 1-module white border around finder patterns
	function addSeparators(matrix, size) {
		for (var i = 0; i < 8; i++) {
			matrix[7][i] = 0;
			matrix[i][7] = 0;
		}
		for (var j = 0; j < 8; j++) {
			matrix[7][size - 8 + j] = 0;
			matrix[j][size - 8] = 0;
		}
		for (var k = 0; k < 8; k++) {
			matrix[size - 8][k] = 0;
			matrix[size - 8 + k][7] = 0;
		}
	}

	// Timing patterns: alternating modules on row 6 and column 6
	function addTimingPatterns(matrix, size) {
		for (var i = 0; i < size; i++) {
			var bit = i % 2 === 0 ? 1 : 0;
			if (matrix[6][i] === null) matrix[6][i] = bit;
			if (matrix[i][6] === null) matrix[i][6] = bit;
		}
	}

	// Alignment patterns: 5x5 with black border, white inner, black center
	function addAlignmentPatterns(matrix, version, size) {
		if (version < 2) return;

		var positions = ALIGNMENT_POSITIONS[version];

		for (var ri = 0; ri < positions.length; ri++) {
			for (var ci = 0; ci < positions.length; ci++) {
				var row = positions[ri], col = positions[ci];
				if (isInFinderPattern(row, col, size)) continue; // skip finder overlap

				for (var r = -2; r <= 2; r++) {
					for (var c = -2; c <= 2; c++) {
						var isBlack;
						if (Math.abs(r) === 2 || Math.abs(c) === 2) {
							isBlack = true;  // outer border
						} else if (r === 0 && c === 0) {
							isBlack = true;  // center
						} else {
							isBlack = false; // inner white ring
						}
						matrix[row + r][col + c] = isBlack ? 1 : 0;
					}
				}
			}
		}
	}

	function isInFinderPattern(row, col, size) {
		if (row <= 7 && col <= 7) return true;
		if (row <= 7 && col >= size - 8) return true;
		if (row >= size - 8 && col <= 7) return true;
		return false;
	}

	// Dark module: always at matrix[4*version+9][8] per spec
	function addDarkModule(matrix, version) {
		matrix[4 * version + 9][8] = 1;
	}

	// Reserve format info areas (filled in later)
	function reserveFormatAreas(matrix, size) {
		for (var i = 0; i < 9; i++) {
			if (matrix[8][i] === null) matrix[8][i] = 0;
			if (matrix[i][8] === null) matrix[i][8] = 0;
		}
		for (var j = 0; j < 8; j++) {
			if (matrix[8][size - 1 - j] === null) matrix[8][size - 1 - j] = 0;
		}
		for (var k = 0; k < 7; k++) {
			if (matrix[size - 1 - k][8] === null) matrix[size - 1 - k][8] = 0;
		}
	}

	// Reserve version info areas (version 7+)
	function reserveVersionAreas(matrix, size) {
		for (var i = 0; i < 6; i++) {
			for (var j = 0; j < 3; j++) {
				matrix[i][size - 11 + j] = 0;
			}
		}
		for (var k = 0; k < 6; k++) {
			for (var m = 0; m < 3; m++) {
				matrix[size - 11 + m][k] = 0;
			}
		}
	}

	function createReservedMap(matrix, size) {
		var reserved = Array.from({ length: size }, function () { return Array(size).fill(false); });

		for (var row = 0; row < size; row++) {
			for (var col = 0; col < size; col++) {
				if (matrix[row][col] !== null) {
					reserved[row][col] = true;
				}
			}
		}

		return reserved;
	}

	function encodeData(bytes, version) {
		var bits = [];
		var charCountBits = version <= 9 ? 8 : 16;

		bits.push(0, 1, 0, 0); // mode: byte

		for (var i = charCountBits - 1; i >= 0; i--) {
			bits.push((bytes.length >> i) & 1); // character count
		}

		for (var b = 0; b < bytes.length; b++) {
			for (var k = 7; k >= 0; k--) {
				bits.push((bytes[b] >> k) & 1);
			}
		}

		// terminator (up to 4 zeros)
		var capacity = EC_TABLE[version][0] * 8;
		for (var t = 0; t < 4 && bits.length < capacity; t++) {
			bits.push(0);
		}

		while (bits.length % 8 !== 0 && bits.length < capacity) {
			bits.push(0); // pad to byte boundary
		}

		// pad codewords
		var padBytes = [0xEC, 0x11];
		var padIndex = 0;
		while (bits.length < capacity) {
			var pad = padBytes[padIndex++ % 2];
			for (var pb = 7; pb >= 0; pb--) {
				bits.push((pad >> pb) & 1);
			}
		}

		return bits;
	}

	function addErrorCorrection(data, version) {
		var row = EC_TABLE[version];
		var totalCap = row[0], ecPerBlock = row[1];
		var g1Count = row[2], g1Data = row[3], g2Count = row[4], g2Data = row[5];

		var dataBytes = [];
		for (var i = 0; i < data.length; i += 8) {
			var byte = 0;
			for (var j = 0; j < 8; j++) byte = (byte << 1) | (data[i + j] || 0);
			dataBytes.push(byte);
		}

		while (dataBytes.length < totalCap) {
			dataBytes.push(dataBytes.length % 2 === 0 ? 0xEC : 0x11); // pad to capacity
		}

		var blocks = [];
		var ecBlocks = [];
		var offset = 0;

		for (var a = 0; a < g1Count; a++) {
			var b1 = dataBytes.slice(offset, offset + g1Data);
			blocks.push(b1);
			ecBlocks.push(generateECBytes(b1, ecPerBlock));
			offset += g1Data;
		}

		for (var c = 0; c < g2Count; c++) {
			var b2 = dataBytes.slice(offset, offset + g2Data);
			blocks.push(b2);
			ecBlocks.push(generateECBytes(b2, ecPerBlock));
			offset += g2Data;
		}

		var resultBytes = [];
		var maxDataSize = Math.max(g1Data, g2Data);

		// interleave data byte-by-byte across all blocks
		for (var d = 0; d < maxDataSize; d++) {
			for (var e = 0; e < blocks.length; e++) {
				if (d < blocks[e].length) {
					resultBytes.push(blocks[e][d]);
				}
			}
		}

		// interleave EC byte-by-byte (EC sizes are always equal)
		for (var f = 0; f < ecPerBlock; f++) {
			for (var g = 0; g < ecBlocks.length; g++) {
				resultBytes.push(ecBlocks[g][f]);
			}
		}

		var resultBits = [];
		for (var rb = 0; rb < resultBytes.length; rb++) {
			for (var h = 7; h >= 0; h--) resultBits.push((resultBytes[rb] >> h) & 1);
		}
		return resultBits;
	}

	function generateECBytes(data, ecCount) {
		var gen = [1];
		for (var i = 0; i < ecCount; i++) {
			var next = new Array(gen.length + 1).fill(0);
			for (var j = 0; j < gen.length; j++) {
				next[j] ^= gen[j];
				next[j + 1] ^= gfMul(gen[j], GF_EXP[i]);
			}
			for (var k = 0; k < next.length; k++) gen[k] = next[k];
			gen.length = next.length;
		}

		var remainder = new Array(ecCount).fill(0);
		for (var d = 0; d < data.length; d++) {
			var factor = data[d] ^ remainder[0];
			remainder.shift();
			remainder.push(0);
			for (var m = 0; m < ecCount; m++) {
				remainder[m] ^= gfMul(gen[m + 1], factor);
			}
		}

		return remainder;
	}

	// Place data in zigzag pattern from bottom-right, skipping column 6
	function placeData(matrix, data, size) {
		var bitIndex = 0;
		var up = true;

		for (var col = size - 1; col >= 1; col -= 2) {
			if (col === 6) col = 5;  // skip timing column

			for (var i = 0; i < size; i++) {
				var row = up ? size - 1 - i : i;

				for (var j = 0; j < 2; j++) {
					var c = col - j;
					if (matrix[row][c] === null) {
						matrix[row][c] = bitIndex < data.length ? data[bitIndex++] : 0;
					}
				}
			}
			up = !up;
		}
	}

	function applyBestMask(matrix, size, reserved) {
		var bestMask = 0;
		var bestPenalty = Infinity;

		for (var mask = 0; mask < 8; mask++) {
			var copy = matrix.map(function (r) { return r.slice(); });
			applyMask(copy, size, mask, reserved);
			var penalty = calculatePenalty(copy, size);

			if (penalty < bestPenalty) {
				bestPenalty = penalty;
				bestMask = mask;
			}
		}

		applyMask(matrix, size, bestMask, reserved);
		return bestMask;
	}

	function applyMask(matrix, size, mask, reserved) {
		for (var row = 0; row < size; row++) {
			for (var col = 0; col < size; col++) {
				if (reserved[row][col]) continue;

				var invert = false;
				switch (mask) {
					case 0: invert = (row + col) % 2 === 0; break;
					case 1: invert = row % 2 === 0; break;
					case 2: invert = col % 3 === 0; break;
					case 3: invert = (row + col) % 3 === 0; break;
					case 4: invert = (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0; break;
					case 5: invert = (row * col) % 2 + (row * col) % 3 === 0; break;
					case 6: invert = ((row * col) % 2 + (row * col) % 3) % 2 === 0; break;
					case 7: invert = ((row + col) % 2 + (row * col) % 3) % 2 === 0; break;
				}

				if (invert) matrix[row][col] ^= 1;
			}
		}
	}

	function calculatePenalty(matrix, size) {
		var penalty = 0;

		// rule 1: 5+ consecutive same-color modules
		for (var i = 0; i < size; i++) {
			var rowRun = 1, colRun = 1;
			for (var j = 1; j < size; j++) {
				rowRun = matrix[i][j] === matrix[i][j - 1] ? rowRun + 1 : 1;
				if (rowRun === 5) penalty += 3;
				else if (rowRun > 5) penalty += 1;

				colRun = matrix[j][i] === matrix[j - 1][i] ? colRun + 1 : 1;
				if (colRun === 5) penalty += 3;
				else if (colRun > 5) penalty += 1;
			}
		}

		// rule 2: 2x2 blocks of same color
		for (var r = 0; r < size - 1; r++) {
			for (var c = 0; c < size - 1; c++) {
				var v = matrix[r][c];
				if (v === matrix[r][c + 1] && v === matrix[r + 1][c] && v === matrix[r + 1][c + 1]) {
					penalty += 3;
				}
			}
		}

		return penalty;
	}

	function addFormatInfo(matrix, size, mask) {
		var format = (0 << 3) | mask; // Level M (00) + Mask
		var rem = format;
		for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
		var bits = ((format << 10) | rem) ^ 0x5412;

		function getBit(i) { return (bits >> i) & 1; }

		var coords = [
			[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]
		];

		for (var c = 0; c < 15; c++) {
			var r = coords[c][0], col = coords[c][1];
			var bit = getBit(c);
			matrix[r][col] = bit; // first copy
			// second copy, mirrored around the other finders
			if (c < 8) {
				matrix[8][size - 1 - c] = bit;
			} else {
				matrix[size - 1 - (14 - c)][8] = bit;
			}
		}
	}

	function addVersionInfo(matrix, version) {
		if (version < 7) return;

		// 18-bit BCH Error Corrected Version Codes
		var versionBits = {
			7:  0x07C94, 8:  0x085BC, 9:  0x09A99, 10: 0x0A4D3,
			11: 0x0BBF6, 12: 0x0C762, 13: 0x0D847, 14: 0x0E60D,
			15: 0x0F928, 16: 0x10B78, 17: 0x1145D, 18: 0x12A17,
			19: 0x13532, 20: 0x149A6, 21: 0x15683, 22: 0x168C9,
			23: 0x177EC, 24: 0x18EC4, 25: 0x191E1, 26: 0x1AFAB,
			27: 0x1B08E, 28: 0x1CC1A, 29: 0x1D33F, 30: 0x1ED75,
			31: 0x1F250, 32: 0x209D5, 33: 0x216F0, 34: 0x228BA,
			35: 0x2379F, 36: 0x24B0B, 37: 0x2542E, 38: 0x26A64,
			39: 0x27541, 40: 0x28C69
		};

		var bits = versionBits[version];
		var size = matrix.length;

		for (var i = 0; i < 18; i++) {
			var bit = (bits >> i) & 1;
			var a = Math.floor(i / 3);
			var b = i % 3;

			matrix[size - 11 + b][a] = bit; // bottom-left block
			matrix[a][size - 11 + b] = bit; // top-right block
		}
	}

	window.qr = { createMatrix: createQR };
})();
