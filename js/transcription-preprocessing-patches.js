/** Exact checkpoint coefficient migration. Never patches unknown/custom weights. */
const patches=[
  {
    "version": 2,
    "variant": "small",
    "modelId": "muscriptor-small-fp32-source",
    "source": {
      "sha256": "bbd482c786b895cf7d8f44185073d951adae2ebb8a66f82ca84cd1f84569549c",
      "bytes": 411888600
    },
    "expected": {
      "graphs": {
        "prefill": {
          "path": "prefill.onnx",
          "bytes": 92980,
          "sha256": "5b2c5592ba477ec6192a1bacca211ce14cba2017a2ffdfbbccc5ea02870c6ab7"
        },
        "step": {
          "path": "step.onnx",
          "bytes": 78969,
          "sha256": "27ab547d47a7748eef1e166766659678a2ba004042e4506a540045df8f241302"
        }
      },
      "mapping": {
        "path": "source-map.json",
        "bytes": 54377,
        "sha256": "a1d1b297fec009aec1c88e778007a6b68ff477b0349dfceea79641e80d45f017"
      },
      "preprocessing": {
        "window": {
          "path": "window.f32",
          "bytes": 8192,
          "sha256": "079d97abbaa733f4221ec0ce886324443910b13aa53912a48d6d06ed32351700"
        },
        "melFilter": {
          "path": "mel-filter.f32",
          "bytes": 2099200,
          "sha256": "471b5a32682f6964dae939480ca7570bc0038ab02139fb0080bd3003bfb95da7"
        }
      }
    },
    "preprocessing": {
      "window": "window-v2.f32",
      "melFilter": "mel-filter-v2.f32"
    },
    "files": [
      {
        "path": "window-v2.f32",
        "url": "../assets/transcription/small/window-v2.f32",
        "bytes": 8192,
        "sha256": "0c84bb4f4654fb07efc1d59ed47f697c95a2d242fe19025791d5211265abed8b"
      },
      {
        "path": "mel-filter-v2.f32",
        "url": "../assets/transcription/small/mel-filter-v2.f32",
        "bytes": 2099200,
        "sha256": "a18c6e6e401ede017e9a95400b3742d87073f60df52c92822c18bcb1e86f4fdb"
      }
    ]
  },
  {
    "version": 2,
    "variant": "medium",
    "modelId": "muscriptor-medium-fp32-source",
    "source": {
      "sha256": "ac80adbdf85d87231735fd948af7013441c0afced316c4e9067fd5d8a7fb97ec",
      "bytes": 1228144472
    },
    "expected": {
      "graphs": {
        "prefill": {
          "path": "prefill.onnx",
          "bytes": 154065,
          "sha256": "5078a0e9993f21a45d4b28e1552a6123a26a8688fd5acf2ff3d2f49fa9964ab1"
        },
        "step": {
          "path": "step.onnx",
          "bytes": 132370,
          "sha256": "041188b5e85928ef6bfe0e209e43ef3a0409d0470562e7177e53839269e30f07"
        }
      },
      "mapping": {
        "path": "source-map.json",
        "bytes": 91179,
        "sha256": "7a7ee24ff827ee5e585daff9cb4e64a5768e050450fd3b12b3bfb7b7cfcf7388"
      },
      "preprocessing": {
        "window": {
          "path": "window.f32",
          "bytes": 8192,
          "sha256": "079d97abbaa733f4221ec0ce886324443910b13aa53912a48d6d06ed32351700"
        },
        "melFilter": {
          "path": "mel-filter.f32",
          "bytes": 2099200,
          "sha256": "471b5a32682f6964dae939480ca7570bc0038ab02139fb0080bd3003bfb95da7"
        }
      }
    },
    "preprocessing": {
      "window": "window-v2.f32",
      "melFilter": "mel-filter-v2.f32"
    },
    "files": [
      {
        "path": "window-v2.f32",
        "url": "../assets/transcription/medium/window-v2.f32",
        "bytes": 8192,
        "sha256": "0c84bb4f4654fb07efc1d59ed47f697c95a2d242fe19025791d5211265abed8b"
      },
      {
        "path": "mel-filter-v2.f32",
        "url": "../assets/transcription/medium/mel-filter-v2.f32",
        "bytes": 2099200,
        "sha256": "a18c6e6e401ede017e9a95400b3742d87073f60df52c92822c18bcb1e86f4fdb"
      }
    ]
  }
];
export const TRANSCRIPTION_PREPROCESSING_PATCHES=Object.freeze(patches.map(patch=>Object.freeze({...patch,files:patch.files.map(file=>Object.freeze({...file,url:new URL(file.url,import.meta.url).href}))})));
