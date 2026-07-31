import { createHash } from 'node:crypto';
import {
	createReadStream,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';

const RECOVERY_IMAGE = {
	name: 'unbrick.bin',
	size: 64_000_000,
	sha256: '97ff33370390d27ffe1fc370be16592e8ebe24e705bbca46cf7e11e0459d0eaf'
};
const BOOTLOADER_NAME = 'bootloader.dump';
const BOOT_PARTITION_NAME = 'stock-boot-partition.bin';
const BOOT_PARTITION_SIZE = 2 * 1024 * 1024;
const INFO_SECTOR_SIZE = 512;
const BL2_SIZE = 64 * 1024;
const STOCK_BL2_SHA256 = 'd6aad144ea090e425a986dbd174a605d80d5768410ba4039e3d160497ca93049';
const ARCHIVE_TIMESTAMP = new Date('2023-01-21T21:58:00Z');

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = resolve(projectRoot, 'firmware/stock');
const metadataPath = resolve(sourceDirectory, 'meta.json');
const outputPath = resolve(process.argv[2] ?? resolve(projectRoot, '8.2.5_stock.zip'));

function referencedFiles(metadata) {
	return new Set(
		metadata.steps.flatMap((step) => {
			const value = step.value;
			const data =
				value && typeof value === 'object' && 'data' in value
					? value.data
					: step.type === 'writeEnv'
						? value
						: undefined;
			return data && typeof data === 'object' && 'filePath' in data ? [data.filePath] : [];
		})
	);
}

async function sha256(path) {
	const hash = createHash('sha256');
	await pipeline(createReadStream(path), hash);
	return hash.digest('hex');
}

function digest(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

function createInfoSector() {
	const info = Buffer.alloc(INFO_SECTOR_SIZE);
	info.writeUInt32LE(1, 0);
	info.writeUInt32LE(73_728, 4);
	info.writeUInt32LE(16_384, 16);
	info.writeUInt32LE(4, 20);

	let checksum = 0;
	for (let offset = 0; offset < INFO_SECTOR_SIZE - 4; offset += 4) {
		checksum = (checksum + info.readUInt32LE(offset)) >>> 0;
	}
	info.writeUInt32LE(checksum, INFO_SECTOR_SIZE - 4);
	return info;
}

function buildStockBootPartition() {
	const bootloaderPath = resolve(sourceDirectory, BOOTLOADER_NAME);
	if (!existsSync(bootloaderPath)) throw new Error(`missing stock payload: ${BOOTLOADER_NAME}`);

	const bootloader = readFileSync(bootloaderPath);
	const contentSize = BOOT_PARTITION_SIZE - INFO_SECTOR_SIZE;
	if (bootloader.length < contentSize) {
		throw new Error(
			`${BOOTLOADER_NAME} is ${bootloader.length} bytes, expected at least ${contentSize}`
		);
	}

	const info = createInfoSector();
	const image = Buffer.concat([info, bootloader.subarray(0, contentSize)]);
	const bl2Digest = digest(image.subarray(INFO_SECTOR_SIZE, INFO_SECTOR_SIZE + BL2_SIZE));
	if (bl2Digest !== STOCK_BL2_SHA256) {
		throw new Error(`stock BL2 sha256 is ${bl2Digest}, expected ${STOCK_BL2_SHA256}`);
	}

	const output = resolve(sourceDirectory, BOOT_PARTITION_NAME);
	writeFileSync(output, image);
	utimesSync(output, ARCHIVE_TIMESTAMP, ARCHIVE_TIMESTAMP);
	return output;
}

function validateStockBootPartition(path) {
	const image = readFileSync(path);
	if (image.length !== BOOT_PARTITION_SIZE) {
		throw new Error(
			`${BOOT_PARTITION_NAME} is ${image.length} bytes, expected ${BOOT_PARTITION_SIZE}`
		);
	}

	const info = image.subarray(0, INFO_SECTOR_SIZE);
	const expectedInfo = createInfoSector();
	if (!info.equals(expectedInfo))
		throw new Error(`${BOOT_PARTITION_NAME} has an invalid info sector`);

	const bootloader = readFileSync(resolve(sourceDirectory, BOOTLOADER_NAME));
	const expectedContent = bootloader.subarray(0, BOOT_PARTITION_SIZE - INFO_SECTOR_SIZE);
	if (!image.subarray(INFO_SECTOR_SIZE).equals(expectedContent)) {
		throw new Error(`${BOOT_PARTITION_NAME} does not contain the stock bootloader at LBA 1`);
	}
}

function run(command, args) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { cwd: sourceDirectory, stdio: 'inherit' });
		child.on('error', reject);
		child.on('exit', (code) => {
			if (code === 0) resolvePromise();
			else reject(new Error(`${command} exited with code ${code}`));
		});
	});
}

const bootPartitionPath = buildStockBootPartition();
validateStockBootPartition(bootPartitionPath);

const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
const files = referencedFiles(metadata);
const missingFiles = [...files].filter((name) => !existsSync(resolve(sourceDirectory, name)));
if (missingFiles.length > 0) {
	throw new Error(`missing stock payloads: ${missingFiles.join(', ')}`);
}

const recoveryStep = metadata.steps.find(
	(step) =>
		step.type === 'writeUserArea' &&
		step.value?.lba === 0 &&
		step.value?.data?.filePath === RECOVERY_IMAGE.name
);
if (!recoveryStep) {
	throw new Error('meta.json does not write unbrick.bin to LBA 0');
}

const bootPartitionSteps = metadata.steps.filter((step) => step.type === 'writeBootPartition');
const bootPartitions = new Set(bootPartitionSteps.map((step) => step.value?.hwpart));
if (
	bootPartitionSteps.length !== 2 ||
	!bootPartitions.has(1) ||
	!bootPartitions.has(2) ||
	bootPartitionSteps.some((step) => step.value?.data?.filePath !== BOOT_PARTITION_NAME)
) {
	throw new Error(`meta.json must write ${BOOT_PARTITION_NAME} to boot0 and boot1`);
}

const recoveryPath = resolve(sourceDirectory, RECOVERY_IMAGE.name);
const recoverySize = statSync(recoveryPath).size;
if (recoverySize !== RECOVERY_IMAGE.size) {
	throw new Error(`unbrick.bin is ${recoverySize} bytes, expected ${RECOVERY_IMAGE.size}`);
}

const recoveryDigest = await sha256(recoveryPath);
if (recoveryDigest !== RECOVERY_IMAGE.sha256) {
	throw new Error(`unbrick.bin sha256 is ${recoveryDigest}, expected ${RECOVERY_IMAGE.sha256}`);
}

mkdirSync(dirname(outputPath), { recursive: true });
rmSync(outputPath, { force: true });
await run('zip', ['-X', '-9', outputPath, 'meta.json', ...files]);

const archiveSize = statSync(outputPath).size;
const archiveDigest = await sha256(outputPath);
console.log(`${basename(outputPath)}\t${archiveSize} bytes\tsha256:${archiveDigest}`);
