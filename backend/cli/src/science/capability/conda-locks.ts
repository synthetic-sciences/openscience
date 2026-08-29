import crypto from "node:crypto"
import os from "node:os"

export const CONDA_LOCK_PLATFORMS = ["osx-arm64", "linux-aarch64", "linux-64"] as const
export type CoreScienceCondaPlatform = (typeof CONDA_LOCK_PLATFORMS)[number]
export type CondaLockHost = { platform: NodeJS.Platform; arch: string; release?: string; glibc?: string }

const atLeast = (value: string | undefined, major: number, minor = 0) => {
  const match = value?.match(/^(\d+)(?:\.(\d+))?/u)
  if (!match) return false
  const current = [Number(match[1]), Number(match[2] ?? 0)]
  return current[0]! > major || (current[0] === major && current[1]! >= minor)
}

function currentHost(): CondaLockHost {
  const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined
  return {
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    glibc: report?.header?.glibcVersionRuntime,
  }
}

export function condaLockPlatform(host: CondaLockHost = currentHost()): CoreScienceCondaPlatform | undefined {
  if (host.platform === "darwin" && host.arch === "arm64" && atLeast(host.release, 21)) return "osx-arm64"
  if (host.platform === "linux" && host.arch === "arm64" && atLeast(host.glibc, 2, 28)) return "linux-aarch64"
  if (host.platform === "linux" && host.arch === "x64" && atLeast(host.glibc, 2, 28)) return "linux-64"
  return undefined
}

const explicit = (packages: readonly string[]) => `@EXPLICIT\n${packages.join("\n")}`
const packageUrl =
  /^https:\/\/conda\.anaconda\.org\/conda-forge\/(osx-arm64|linux-aarch64|linux-64|noarch)\/[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\.conda|\.tar\.bz2)#sha256=[a-f0-9]{64}$/u

export function condaLockError(platform: CoreScienceCondaPlatform, value: string) {
  const lines = value.split("\n")
  if (lines[0] !== "@EXPLICIT" || lines.length < 2) return "Conda locks must start with @EXPLICIT and contain packages"
  for (const line of lines.slice(1)) {
    const match = line.match(packageUrl)
    if (!match) return "Conda lock entries must be exact conda-forge HTTPS package URLs with sha256 fragments"
    if (match[1] !== platform && match[1] !== "noarch") {
      return `Conda lock entries for ${platform} may only use ${platform} or noarch packages`
    }
  }
  return undefined
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`
  return JSON.stringify(value)
}

export const condaLockSha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex")
export const capabilityLockDigest = (value: unknown) =>
  crypto.createHash("sha256").update(canonical(value)).digest("hex")

const locks = {
  "osx-arm64": explicit([
    "https://conda.anaconda.org/conda-forge/osx-arm64/libffi-3.4.6-h1da3d7d_1.conda#sha256=c6a530924a9b14e193ea9adfe92843de2a806d1b7dbfd341546ece9653129e60",
    "https://conda.anaconda.org/conda-forge/osx-arm64/ncurses-6.6-he64c551_1.conda#sha256=7024a48c8c0d0114ed4ab53c76bf9275d50e91ba7cea367a9aead638d3c29c68",
    "https://conda.anaconda.org/conda-forge/osx-arm64/liblzma-5.8.3-h8088a28_1.conda#sha256=23d0630046a3e8b164d8f80f2b74ed2605af2e7050ab9913018056402fae4311",
    "https://conda.anaconda.org/conda-forge/osx-arm64/libexpat-2.8.1-hf6b4638_1.conda#sha256=5af74261101e3c777399c6294b2b5d290e508153268eb2e9ff99c4d69834612f",
    "https://conda.anaconda.org/conda-forge/osx-arm64/libzlib-1.3.2-h8088a28_3.conda#sha256=a18fa5d5bac452401459f966cf0d872224e8080c4ff93c77e168d43ab42ef9d7",
    "https://conda.anaconda.org/conda-forge/osx-arm64/bzip2-1.0.8-h4e30115_10.conda#sha256=8ec22f0ba25cbfc2e64d70cf29459eccd7ffdf6436f6a6ff15bbfef799f7d4f6",
    "https://conda.anaconda.org/conda-forge/osx-arm64/icu-78.3-py310h579977c_2.conda#sha256=6cdb5dee54c72e56ab189fb3ad33cb28533553d42590e7e831160248f4416a43",
    "https://conda.anaconda.org/conda-forge/osx-arm64/readline-8.3-h8b90a29_1.conda#sha256=d6782b430e6dce4fe8c7ac118cd988d5a193eb4a7f60741edfaede58016b6110",
    "https://conda.anaconda.org/conda-forge/osx-arm64/tk-8.6.13-hbeba79b_4.conda#sha256=857d89087ae7f2c328cf256728affcb7343031a148b4af847334d248a9cf564c",
    "https://conda.anaconda.org/conda-forge/osx-arm64/libsqlite-3.53.4-hca69786_1.conda#sha256=839b31d4830e896b4d315b551d27f2bb08026bc946df04bcc360d8627c3ba2cd",
    "https://conda.anaconda.org/conda-forge/noarch/tzdata-2026c-h151e31d_0.conda#sha256=b928c30ddcb0e3f544c6eade8352737e6e610e263276b90232db6a578ef899d8",
    "https://conda.anaconda.org/conda-forge/noarch/ca-certificates-2026.7.22-hbd8a1cb_0.conda#sha256=0a0544cf95f64394fe4959286f5c71f5444ad58feb0602e53becb27448d24da6",
    "https://conda.anaconda.org/conda-forge/osx-arm64/openssl-3.6.4-h55eecbc_0.conda#sha256=f23239eacd75c4c50705e68fae1aa3292da473e6a3a4abe2330f1e6afa680704",
    "https://conda.anaconda.org/conda-forge/osx-arm64/python-3.12.11-hc22306f_0_cpython.conda#sha256=cde8b944c2dc378a5afbc48028d0843583fd215493d5885a80f1b41de085552f",
    "https://conda.anaconda.org/conda-forge/noarch/packaging-26.3-pyhc364b38_0.conda#sha256=c432626b16768b8dab228bfb706f7060c2d462a21c516d240f68f2f902b5a044",
    "https://conda.anaconda.org/conda-forge/noarch/setuptools-84.0.0-pyh332efcf_0.conda#sha256=9e200ee5f9ff19a4d94e4b51c4856d53dec849f91032f345cf0c6bc3d51a7183",
    "https://conda.anaconda.org/conda-forge/noarch/wheel-0.48.0-pyhd8ed1ab_0.conda#sha256=ba64b29b6d418024cb565081a1799262cb2780d2534ff4c14f76aa858c4286cd",
    "https://conda.anaconda.org/conda-forge/noarch/pip-25.1.1-pyh8b19718_0.conda#sha256=ebfa591d39092b111b9ebb3210eb42251be6da89e26c823ee03e5e838655a43e",
  ]),
  "linux-aarch64": explicit([
    "https://conda.anaconda.org/conda-forge/linux-aarch64/libzlib-1.3.2-hdc9db2a_3.conda#sha256=76efa6cc9d7e6f5ee3bbca0939f64054af2bdfb3c3632531f8e633cf6c2ea41e",
    "https://conda.anaconda.org/conda-forge/linux-aarch64/libgomp-16.2.0-h8acb6b2_4.conda#sha256=6d216e6dc9a158b920f6e0c1dfdd6d77575bf79420dadf85d64576298ecb4503",
    "https://conda.anaconda.org/conda-forge/linux-aarch64/zstd-1.5.7-h9d15635_7.conda#sha256=427fd14bcb3b8659796fecc682716617409350fb5a98e5b7b47558a10d1a2fc7",
    "https://conda.anaconda.org/conda-forge/linux-aarch64/_openmp_mutex-4.5-20_gnu.conda#sha256=a2527b1d81792a0ccd2c05850960df119c2b6d8f5fdec97f2db7d25dc23b1068",
    "https://conda.anaconda.org/conda-forge/linux-aarch64/ld_impl_linux-aarch64-2.46.1-default_h1979696_102.conda#sha256=2c4901f4227b0850328ed0c69f958b30ad2cd18982f7a31c7c1f911827004d08",
    "https://conda.anaconda.org/conda-forge/linux-aarch64/libgcc-16.2.0-h205dda4_4.conda#sha256=a132d78d49d0fa0a08e9e2a77528a12d974e8e123bc32895c0bd0a737b8abd89",
    "https://conda.anaconda.org/conda-forge/linux-aarch64/libstdcxx-16.2.0-hef695bb_4.conda#sha256=84d2b667bce6549325243235952110b1849ff2dfd7091a1479108930b88057d5",
    "https://conda.anaconda.org/conda-forge/linux-aarch64/bzip2-1.0.8-h4777abc_10.conda#sha256=24eacc8a20fd7c4616566178562bef7f9344eb4a8700cfc3180fa75a6ff9d39f",
    "https://conda.anaconda.org/conda-forge/linux-aarch64/libnsl-2.0.1-h86ecc28_1.conda#sha256=c0dc4d84198e3eef1f37321299e48e2754ca83fd12e6284754e3cb231357c3a5",
    "https://conda.anaconda.org/conda-forge/linux-aarch64/libexpat-2.8.1-hfae3067_1.conda#sha256=20a5726bc8705d91437c9e6ef83b30da64a1719b869656d20a1ee818333ea5ac",
    "https://conda.anaconda.org/conda-forge/linux-aarch64/libuuid-2.42.2-h1022ec0_0.conda#sha256=7663489f97c104ae3814db10f384932c74b439f3c1fd4247e4fe3599830c090a",
    "https://conda.anaconda.org/conda-forge/linux-aarch64/libffi-3.4.6-he21f813_1.conda#sha256=608b8c8b0315423e524b48733d91edd43f95cb3354a765322ac306a858c2cd2e",
    "https://conda.anaconda.org/conda-forge/linux-aarch64/libxcrypt-4.4.38-h80f16a2_0.conda#sha256=d3514900e2121972e435f7803763c1843dad6709e48aa02a2b47c4d481f83be7",
    "https://conda.anaconda.org/conda-forge/linux-aarch64/liblzma-5.8.3-he30d5cf_1.conda#sha256=f760669fd1cea27f689f411c0d5488e26ce50e382c9b63e4ad348f959850124a",
    "https://conda.anaconda.org/conda-forge/linux-aarch64/ncurses-6.6-h2b6f883_1.conda#sha256=d69a04914139627f0a6bfd19412d6c7f1e37edc896af84a6011e07e8bc1e69fa",
    "https://conda.anaconda.org/conda-forge/linux-aarch64/tk-8.6.13-noxft_hf03c496_4.conda#sha256=a1aa0d0f0b3d539644ff992e6dd0facf950c79df58fc37590ce5be84ff5e3f22",
    "https://conda.anaconda.org/conda-forge/linux-aarch64/icu-78.3-py311h3512406_2.conda#sha256=54d921defd947adb58a90e10203d3bfe6c1f209f5f1a1ad2c6a9f7617f2fb59e",
    "https://conda.anaconda.org/conda-forge/linux-aarch64/readline-8.3-ha7194a6_1.conda#sha256=80167dcf73a96b6d0c1bb2298d7b8b9bc21b27cc5bf56979f9c548b49a4d1722",
    "https://conda.anaconda.org/conda-forge/linux-aarch64/libsqlite-3.53.4-h399dd60_1.conda#sha256=fae75e68e9dbc3c90dcf93d4bae6315f1330c95aaf1404a721e8468266c23475",
    "https://conda.anaconda.org/conda-forge/noarch/tzdata-2026c-h151e31d_0.conda#sha256=b928c30ddcb0e3f544c6eade8352737e6e610e263276b90232db6a578ef899d8",
    "https://conda.anaconda.org/conda-forge/noarch/ca-certificates-2026.7.22-hbd8a1cb_0.conda#sha256=0a0544cf95f64394fe4959286f5c71f5444ad58feb0602e53becb27448d24da6",
    "https://conda.anaconda.org/conda-forge/linux-aarch64/openssl-3.6.4-he6ad1d5_0.conda#sha256=a70c05a9baba9b1ce17c7e8b9479029372069b3bf402dbf200bc03696c531bed",
    "https://conda.anaconda.org/conda-forge/linux-aarch64/python-3.12.11-h1683364_0_cpython.conda#sha256=dceb45dbec8612bf55fd9f4823cac89c4a2e08e9069b37efdc142e398d910e88",
    "https://conda.anaconda.org/conda-forge/noarch/packaging-26.3-pyhc364b38_0.conda#sha256=c432626b16768b8dab228bfb706f7060c2d462a21c516d240f68f2f902b5a044",
    "https://conda.anaconda.org/conda-forge/noarch/setuptools-84.0.0-pyh332efcf_0.conda#sha256=9e200ee5f9ff19a4d94e4b51c4856d53dec849f91032f345cf0c6bc3d51a7183",
    "https://conda.anaconda.org/conda-forge/noarch/wheel-0.48.0-pyhd8ed1ab_0.conda#sha256=ba64b29b6d418024cb565081a1799262cb2780d2534ff4c14f76aa858c4286cd",
    "https://conda.anaconda.org/conda-forge/noarch/pip-25.1.1-pyh8b19718_0.conda#sha256=ebfa591d39092b111b9ebb3210eb42251be6da89e26c823ee03e5e838655a43e",
  ]),
  "linux-64": explicit([
    "https://conda.anaconda.org/conda-forge/linux-64/libzlib-1.3.2-h25fd6f3_3.conda#sha256=eb8a0db0aa570124f7d2a93d7c7f596e3390df5e047818d873baad32985fc736",
    "https://conda.anaconda.org/conda-forge/linux-64/libgomp-16.2.0-he0feb66_4.conda#sha256=0fe5cb8e0752241ab55e11656ed1b9726248b522d23b929fe7c95b83eb55b9bb",
    "https://conda.anaconda.org/conda-forge/linux-64/zstd-1.5.7-hb78ec9c_7.conda#sha256=47d682b9f6d6ec9eb1a6e6c3e75ea6273e899e78fb7fc59f81d39745009fbc60",
    "https://conda.anaconda.org/conda-forge/linux-64/_openmp_mutex-4.5-20_gnu.conda#sha256=1dd3fffd892081df9726d7eb7e0dea6198962ba775bd88842135a4ddb4deb3c9",
    "https://conda.anaconda.org/conda-forge/linux-64/ld_impl_linux-64-2.46.1-default_hbd61a6d_102.conda#sha256=27d83f1188cd19bcb7754a078b3fa7f4cfb8527f8eb2fde54dd01fc529d1adec",
    "https://conda.anaconda.org/conda-forge/linux-64/libgcc-16.2.0-ha9f2e26_4.conda#sha256=24090e675d34403b4ee1cd4372d8f6c0937da7ecfd66a19a57cac2ed0f4ea793",
    "https://conda.anaconda.org/conda-forge/linux-64/libstdcxx-16.2.0-h934c35e_4.conda#sha256=40b792b0186c1e8859280a1f6f19a54fc50a11b32724fc7b637009c1a9bd302b",
    "https://conda.anaconda.org/conda-forge/linux-64/bzip2-1.0.8-hda65f42_10.conda#sha256=1a0d382c515ebf55f8ee1f38c8b81bc95af5c2acc42ad53b66bc5df932032f96",
    "https://conda.anaconda.org/conda-forge/linux-64/libnsl-2.0.1-hb9d3cd8_1.conda#sha256=927fe72b054277cde6cb82597d0fcf6baf127dcbce2e0a9d8925a68f1265eef5",
    "https://conda.anaconda.org/conda-forge/linux-64/libexpat-2.8.1-hecca717_1.conda#sha256=16feffd9ddbbe5b718515d38ee376c685ba95491cd901244e24671d20b952a77",
    "https://conda.anaconda.org/conda-forge/linux-64/libuuid-2.42.2-h5347b49_0.conda#sha256=9b1bdce27a7e31f7d241aeecff67a1f3101d52a2b1e33ccc2cdf2613072bf81f",
    "https://conda.anaconda.org/conda-forge/linux-64/libffi-3.4.6-h2dba641_1.conda#sha256=764432d32db45466e87f10621db5b74363a9f847d2b8b1f9743746cd160f06ab",
    "https://conda.anaconda.org/conda-forge/linux-64/libxcrypt-4.4.38-h280c20c_0.conda#sha256=f7e9292dd219a6435bbb1223da9586c3e70d66d169c5a92f08db3f2127df04e9",
    "https://conda.anaconda.org/conda-forge/linux-64/liblzma-5.8.3-hb03c661_1.conda#sha256=9787df8c22a59c9a70d3e5a10db9ad663485e75e9ccc3f09bd092cb7b95e0dab",
    "https://conda.anaconda.org/conda-forge/linux-64/ncurses-6.6-hdb14827_1.conda#sha256=5d46557214ed184381dafe835b7c94a474a1c3b307a08a250b1ea4779b44ffb3",
    "https://conda.anaconda.org/conda-forge/linux-64/tk-8.6.13-noxft_h1df4ec4_4.conda#sha256=a1a241d172c1ccab067ba245206dd048bc3c2d1b84504b53c9468e99adfc16a1",
    "https://conda.anaconda.org/conda-forge/linux-64/icu-78.3-py310h44b86e0_2.conda#sha256=9f07834f0c546ab14d885ce0366285f61f44e326c0edd1fc63b8294e113ae432",
    "https://conda.anaconda.org/conda-forge/linux-64/readline-8.3-hd6e31c0_1.conda#sha256=01b3fe073a66e321970d09e04b388708f8cbdca5cdfbfcb7c9eeb470ad10383d",
    "https://conda.anaconda.org/conda-forge/linux-64/libsqlite-3.53.4-h13e7031_1.conda#sha256=f20d70da54e5b31dd4a51fb1efeaafafd5ab6dd8d7ac9d1438eaa2526ac4ed3d",
    "https://conda.anaconda.org/conda-forge/noarch/tzdata-2026c-h151e31d_0.conda#sha256=b928c30ddcb0e3f544c6eade8352737e6e610e263276b90232db6a578ef899d8",
    "https://conda.anaconda.org/conda-forge/noarch/ca-certificates-2026.7.22-hbd8a1cb_0.conda#sha256=0a0544cf95f64394fe4959286f5c71f5444ad58feb0602e53becb27448d24da6",
    "https://conda.anaconda.org/conda-forge/linux-64/openssl-3.6.4-h781a0a9_0.conda#sha256=4747b2d6a8336f52343bceb8a1ebf41a9e6e665b9d2e3f989972de53a310599e",
    "https://conda.anaconda.org/conda-forge/linux-64/python-3.12.11-h9e4cc4f_0_cpython.conda#sha256=6cca004806ceceea9585d4d655059e951152fc774a471593d4f5138e6a54c81d",
    "https://conda.anaconda.org/conda-forge/noarch/packaging-26.3-pyhc364b38_0.conda#sha256=c432626b16768b8dab228bfb706f7060c2d462a21c516d240f68f2f902b5a044",
    "https://conda.anaconda.org/conda-forge/noarch/setuptools-84.0.0-pyh332efcf_0.conda#sha256=9e200ee5f9ff19a4d94e4b51c4856d53dec849f91032f345cf0c6bc3d51a7183",
    "https://conda.anaconda.org/conda-forge/noarch/wheel-0.48.0-pyhd8ed1ab_0.conda#sha256=ba64b29b6d418024cb565081a1799262cb2780d2534ff4c14f76aa858c4286cd",
    "https://conda.anaconda.org/conda-forge/noarch/pip-25.1.1-pyh8b19718_0.conda#sha256=ebfa591d39092b111b9ebb3210eb42251be6da89e26c823ee03e5e838655a43e",
  ]),
} as const

for (const platform of CONDA_LOCK_PLATFORMS) {
  const error = condaLockError(platform, locks[platform])
  if (error) throw new Error(`Invalid core science ${platform} Conda lock: ${error}`)
}

export const CORE_SCIENCE_CONDA_LOCKS = locks
