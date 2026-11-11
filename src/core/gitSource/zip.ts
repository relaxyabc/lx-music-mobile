import { inflateRaw } from 'pako'
import { MAX_ASSET_SIZE, MAX_SCRIPT_SIZE } from './constants'

/** 压缩包内允许出现的最大文件数量 */
const MAX_ZIP_ENTRIES = 2000

const EOCD_SIGNATURE = 0x06054B50
const CENTRAL_DIR_SIGNATURE = 0x02014B50
const LOCAL_HEADER_SIGNATURE = 0x04034B50

const readUint16 = (buffer: Uint8Array, offset: number) => {
  return buffer[offset] | (buffer[offset + 1] << 8)
}

const readUint32 = (buffer: Uint8Array, offset: number) => {
  return (buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16) | (buffer[offset + 3] << 24)) >>> 0
}

const decodeName = (bytes: Uint8Array, utf8: boolean): string => {
  if (utf8) {
    try {
      return new TextDecoder('utf-8').decode(bytes)
    } catch { /* 环境不支持时回退到逐字节解码 */ }
  }
  let name = ''
  for (let i = 0; i < bytes.length; i++) name += String.fromCharCode(bytes[i])
  return name
}

const endsWithJs = (bytes: Uint8Array): boolean => {
  if (bytes.length < 3) return false
  const len = bytes.length
  return bytes[len - 3] === 0x2E &&
    (bytes[len - 2] === 0x4A || bytes[len - 2] === 0x6A) &&
    (bytes[len - 1] === 0x53 || bytes[len - 1] === 0x73)
}

export interface ZipEntry {
  name: string
  data: Uint8Array
}

/**
 * 解析 ZIP 压缩包并解出其中的文件。
 *
 * 只支持 stored(0) 与 deflate(8) 两种压缩方式（音源发布包均为这两种），
 * 会跳过目录项、加密项与无法识别的压缩方式。
 *
 * 注意：文件名可能是 GBK 编码，这里不做正确解码（仅用于诊断），
 * 是否以 `.js` 结尾通过原始字节判断。
 */
export const extractZip = (buffer: Uint8Array): ZipEntry[] => {
  if (!(buffer instanceof Uint8Array) || buffer.length < 22) {
    throw new Error('Invalid zip file: file is too small')
  }

  // 从尾部向前查找 EOCD（末尾可能带有最多 65535 字节的注释）
  let eocdOffset = -1
  const minOffset = Math.max(0, buffer.length - 22 - 0xFFFF)
  for (let offset = buffer.length - 22; offset >= minOffset; offset--) {
    if (readUint32(buffer, offset) === EOCD_SIGNATURE) {
      eocdOffset = offset
      break
    }
  }
  if (eocdOffset < 0) throw new Error('Invalid zip file: end of central directory not found')

  const entryCount = readUint16(buffer, eocdOffset + 10)
  const centralDirOffset = readUint32(buffer, eocdOffset + 16)
  const centralDirSize = readUint32(buffer, eocdOffset + 12)
  if (entryCount === 0xFFFF || centralDirOffset === 0xFFFFFFFF || centralDirSize === 0xFFFFFFFF) {
    throw new Error('Unsupported zip file: ZIP64 is not supported')
  }
  if (entryCount > MAX_ZIP_ENTRIES) {
    throw new Error(`Zip file contains too many entries (max ${MAX_ZIP_ENTRIES})`)
  }
  if (centralDirOffset + centralDirSize > buffer.length) {
    throw new Error('Invalid zip file: central directory is out of range')
  }

  const result: ZipEntry[] = []
  let totalExtracted = 0
  let offset = centralDirOffset

  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > buffer.length || readUint32(buffer, offset) !== CENTRAL_DIR_SIGNATURE) {
      throw new Error('Invalid zip file: broken central directory entry')
    }
    const flags = readUint16(buffer, offset + 8)
    const method = readUint16(buffer, offset + 10)
    const compressedSize = readUint32(buffer, offset + 20)
    const uncompressedSize = readUint32(buffer, offset + 24)
    const nameLength = readUint16(buffer, offset + 28)
    const extraLength = readUint16(buffer, offset + 30)
    const commentLength = readUint16(buffer, offset + 32)
    const localHeaderOffset = readUint32(buffer, offset + 42)
    const nameStart = offset + 46
    const nameEnd = nameStart + nameLength
    if (nameEnd > buffer.length) throw new Error('Invalid zip file: broken entry name')

    const nameBytes = buffer.subarray(nameStart, nameEnd)
    const nextOffset = nameEnd + extraLength + commentLength
    offset = nextOffset

    // 目录项、加密项、非脚本文件、超出大小限制的文件直接跳过
    if (!nameBytes.length || nameBytes[nameBytes.length - 1] === 0x2F) continue
    if ((flags & 0x1) !== 0) continue
    if (!endsWithJs(nameBytes)) continue
    if (uncompressedSize > MAX_SCRIPT_SIZE) continue

    if (localHeaderOffset + 30 > buffer.length || readUint32(buffer, localHeaderOffset) !== LOCAL_HEADER_SIGNATURE) {
      throw new Error('Invalid zip file: broken local file header')
    }
    const localNameLength = readUint16(buffer, localHeaderOffset + 26)
    const localExtraLength = readUint16(buffer, localHeaderOffset + 28)
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > buffer.length) throw new Error('Invalid zip file: entry data is out of range')

    const raw = buffer.subarray(dataStart, dataEnd)
    let data: Uint8Array
    if (method === 0) {
      data = raw
    } else if (method === 8) {
      try {
        data = inflateRaw(raw)
      } catch (error: any) {
        throw new Error(`Invalid deflate data in zip entry: ${error?.message ?? String(error)}`)
      }
    } else {
      // 不支持的压缩方式（bzip2 等）直接跳过
      continue
    }

    if (data.length > MAX_SCRIPT_SIZE) throw new Error(`Zip entry is too large (max ${MAX_SCRIPT_SIZE} bytes)`)
    totalExtracted += data.length
    if (totalExtracted > MAX_ASSET_SIZE) throw new Error(`Zip content is too large (max ${MAX_ASSET_SIZE} bytes)`)

    result.push({
      name: decodeName(nameBytes, (flags & 0x800) !== 0),
      data,
    })
  }

  return result
}
