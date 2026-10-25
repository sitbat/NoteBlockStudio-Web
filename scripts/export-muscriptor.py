#!/usr/bin/env python3
"""Export licensed local MuScriptor weights to a static-browser ONNX package.

Development tool only. Never deployed or run by the website. No server is started.
Graph math follows MuScriptor (MIT), Copyright (c) 2026 Kyutai x Mirelo.
Random-weight exports are explicitly testOnly and cannot transcribe music.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time


def arguments():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--upstream', type=Path, default=Path(__file__).resolve().parents[3] / 'work' / 'muscriptor-upstream', help='Official muscriptor source checkout')
    parser.add_argument('--variant', choices=['small', 'medium'], default='small')
    parser.add_argument('--precision', choices=['fp32', 'fp16', 'int8'], default='fp32', help='FP16 uses half transformer weights with FP32 positional math; INT8 targets CPU/WASM only')
    parser.add_argument('--unroll-step', type=Path, help='Create an 8-step autoregressive GPU candidate from an existing step.onnx; no weight files are read')
    parser.add_argument('--decoder-argmax', action='store_true', help='Export only the small shared GPU token/history decoder graph; no model or weights required')
    parser.add_argument('--source-template', action='store_true', help='Export only small graphs and a safetensors-to-external-data recipe; no weights are kept in output')
    parser.add_argument('--source-fixture', type=Path, help='For source-template tests only: write random source.safetensors and reference external data outside the template directory')
    parser.add_argument('--preprocessing-weights', type=Path, help='Read only the exact saved window/filter buffers from a licensed checkpoint for a source template; default full-size templates use the verified repository v2 buffers')
    parser.add_argument('--weights', type=Path, help='Existing, licensed local model.safetensors; never downloaded automatically')
    parser.add_argument('--output', type=Path, required=True, help='New or empty output directory; existing packages are never overwritten')
    parser.add_argument('--dummy', action='store_true', help='Export a tiny random-weight TEST-ONLY model for integration tests')
    parser.add_argument('--dummy-full-size', action='store_true', help='Use the real variant architecture with random TEST-ONLY weights')
    parser.add_argument('--threads', type=int, default=4, help='CPU threads used only during export/parity checks')
    parser.add_argument('--skip-onnx-validation', action='store_true', help='Skip ONNX execution comparison; package is marked unverified')
    args = parser.parse_args()
    if args.decoder_argmax or args.unroll_step:
        if args.decoder_argmax and args.unroll_step:
            parser.error('Choose one auxiliary graph mode.')
        args.output = args.output.resolve()
        if args.output.exists() and (not args.output.is_dir() or any(args.output.iterdir())):
            parser.error('--output must be new or empty.')
        return args
    if args.dummy and args.dummy_full_size:
        parser.error('Choose either --dummy or --dummy-full-size.')
    if bool(args.weights) == bool(args.dummy or args.dummy_full_size):
        parser.error('Supply exactly one of --weights, --dummy or --dummy-full-size. Model access and license acceptance must be completed by you first.')
    if args.source_template and (args.precision != 'fp32' or args.weights):
        parser.error('--source-template currently requires FP32 and --dummy / --dummy-full-size; source data is substituted in the browser.')
    if args.preprocessing_weights:
        if not args.source_template:
            parser.error('--preprocessing-weights is only for source templates; --weights already loads all checkpoint buffers.')
        args.preprocessing_weights=args.preprocessing_weights.resolve()
        if not args.preprocessing_weights.is_file():
            parser.error('--preprocessing-weights must be an existing local safetensors file.')
    if args.source_fixture and not (args.source_template and args.dummy):
        parser.error('--source-fixture requires a tiny --dummy --source-template run.')
    if args.source_fixture:
        args.source_fixture = args.source_fixture.resolve()
        if args.source_fixture.exists():
            parser.error('--source-fixture already exists; choose a new path.')
    if args.threads < 1 or args.threads > 32:
        parser.error('--threads must be 1..32')
    args.upstream = args.upstream.resolve()
    if not (args.upstream / 'muscriptor' / 'transcription_model.py').is_file():
        parser.error('Missing official MuScriptor source checkout; use --upstream.')
    args.output = args.output.resolve()
    if args.output.exists() and (not args.output.is_dir() or any(args.output.iterdir())):
        parser.error('--output must be new or empty. Choose another path to preserve existing files.')
    if args.weights:
        args.weights = args.weights.resolve()
        if not args.weights.is_file():
            parser.error('--weights is not a local file.')
    return args


def sha_file(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()



def export_source_mapping(directory, model, onnx, np):
    """Replace every learned tensor with a shape/key based external-data recipe.

    The source model parameters are deliberately distinct random values. Matching
    their bytes discovers exporter transformations; recipe semantics do not contain
    or depend on those random values. Only copy, whole-matrix transpose, and a
    contiguous slice of the original flattened source tensor are supported.
    """
    source_parameters = {name: parameter.detach().cpu().numpy() for name, parameter in model.named_parameters()}
    candidates = {}
    aliases = {'emb.weight': ['emb.0.weight'], 'linear.weight': ['linears.0.weight']}
    def register(array, descriptor):
        contiguous = np.ascontiguousarray(array, dtype='<f4')
        raw = contiguous.tobytes()
        signature = (len(raw), hashlib.sha256(raw).digest())
        candidates.setdefault(signature, []).append(descriptor)
    for name, array in source_parameters.items():
        source_shape = list(array.shape)
        basic = {'sourceKey': name, 'sourceDtype': 'F32', 'targetDtype': 'F32', 'sourceShape': source_shape}
        register(array, {**basic, 'op': 'copy'})
        if array.ndim == 2:
            register(array.T, {**basic, 'op': 'transpose2d'})
            if name.endswith(('instrument_group.embed.weight', 'dataset_name.embed.weight')):
                register(array[1], {**basic, 'op': 'slice', 'slice': {'start': int(array.shape[1]), 'count': int(array.shape[1])}})
    segments, source_tensors, allocated = [], {}, {}
    with (directory / 'weights.bin').open('wb') as output:
        def externalize(tensor):
            if tensor.data_type != onnx.TensorProto.FLOAT:
                return False
            raw = onnx.numpy_helper.to_array(tensor).astype('<f4', copy=False).tobytes()
            matches = candidates.get((len(raw), hashlib.sha256(raw).digest()))
            if not matches:
                if tensor.name.startswith('core.') or tensor.name.startswith('onnx::MatMul_'):
                    raise ValueError(f'Unmapped learned initializer {tensor.name}; refusing to leave model weights in the graph')
                return False
            preferred = tensor.name.removeprefix('core.')
            match = next((candidate for candidate in matches if candidate['sourceKey'] == preferred and candidate['op'] == 'copy'), matches[0])
            semantic = (match['sourceKey'], match['op'], json.dumps(match.get('slice'), sort_keys=True))
            if semantic not in allocated:
                segment = {**match, 'offset': output.tell(), 'bytes': len(raw), 'shape': list(tensor.dims)}
                segments.append(segment); allocated[semantic] = segment
                output.write(raw)
            segment = allocated[semantic]
            if len(raw) != segment['bytes']:
                raise ValueError('Source mapping transformed size mismatch')
            name = match['sourceKey']
            source_tensors[name] = {'dtype': 'F32', 'shape': match['sourceShape'], **({'aliases': aliases[name]} if name in aliases else {})}
            tensor.raw_data = raw
            onnx.external_data_helper.set_external_data(tensor, location='weights.bin', offset=segment['offset'], length=segment['bytes'])
            tensor.ClearField('raw_data')
            return True
        for graph_name in ('prefill.onnx', 'step.onnx'):
            graph_path = directory / graph_name
            graph = onnx.load(str(graph_path), load_external_data=False)
            for tensor in graph.graph.initializer:
                externalize(tensor)
            # Some exporter versions place a folded class-vector in Constant
            # attributes instead of initializers. Convert those to external inits.
            remove = []
            for node in graph.graph.node:
                if node.op_type != 'Constant' or len(node.output) != 1:
                    continue
                for attribute in node.attribute:
                    if attribute.name == 'value' and attribute.type == onnx.AttributeProto.TENSOR:
                        tensor = onnx.TensorProto(); tensor.CopyFrom(attribute.t); tensor.name = node.output[0]
                        if externalize(tensor):
                            graph.graph.initializer.append(tensor); remove.append(node)
            for node in remove:
                graph.graph.node.remove(node)
            onnx.save_model(graph, str(graph_path))
    total = (directory / 'weights.bin').stat().st_size
    cursor = 0
    for segment in segments:
        if segment['offset'] != cursor:
            raise ValueError('Source recipe must cover the derived file without gaps')
        cursor += segment['bytes']
    if cursor != total:
        raise ValueError('Source recipe coverage mismatch')
    mapping = {'kind': 'nbs-muscriptor-weight-map', 'version': 1, 'target': {'path': 'weights.bin', 'bytes': total}, 'source': {'format': 'safetensors', 'tensors': source_tensors}, 'segments': segments}
    (directory / 'source-map.json').write_text(json.dumps(mapping, indent=2) + '\n', encoding='utf-8')
    return mapping


def write_source_fixture(fixture_path, directory, model, mapping, np):
    """Independently reconstruct external bytes from a tiny raw safetensors file."""
    from safetensors.torch import save_file
    fixture_path.parent.mkdir(parents=True, exist_ok=True)
    parameters = {name: parameter.detach().cpu().contiguous() for name, parameter in model.named_parameters()}
    legacy = {}
    for name, tensor in parameters.items():
        legacy_name = 'emb.0.weight' if name == 'emb.weight' else 'linears.0.weight' if name == 'linear.weight' else name
        legacy[legacy_name] = tensor
    save_file(legacy, str(fixture_path))
    reference = fixture_path.with_suffix('.weights.bin')
    rebuilt = fixture_path.with_suffix('.rebuilt.bin')
    shutil.copyfile(directory / 'weights.bin', reference)
    total_bytes = fixture_path.stat().st_size
    with fixture_path.open('rb') as source, rebuilt.open('wb') as target:
        header_size = int.from_bytes(source.read(8), 'little')
        if not 1 <= header_size <= 1024 * 1024:
            raise ValueError('Invalid source fixture header size')
        header = json.loads(source.read(header_size))
        data_offset = 8 + header_size
        for segment in mapping['segments']:
            descriptor = mapping['source']['tensors'][segment['sourceKey']]
            keys = [key for key in [segment['sourceKey'], *descriptor.get('aliases', [])] if key in header]
            if len(keys) != 1:
                raise ValueError('Source key alias must identify exactly one tensor')
            info = header[keys[0]]
            if info['dtype'] != descriptor['dtype'] or info['shape'] != descriptor['shape']:
                raise ValueError('Source fixture metadata mismatch')
            start, end = info['data_offsets']
            expected_size = int(np.prod(info['shape'])) * 4
            if end - start != expected_size or start < 0 or data_offset + end > total_bytes:
                raise ValueError('Source tensor bounds mismatch')
            source.seek(data_offset + start)
            raw = source.read(expected_size)
            array = np.frombuffer(raw, dtype='<f4').reshape(info['shape'])
            if segment['op'] == 'transpose2d':
                array = array.T
            elif segment['op'] == 'slice':
                part = segment['slice']; array = array.reshape(-1)[part['start']:part['start'] + part['count']]
            elif segment['op'] != 'copy':
                raise ValueError('Unsupported source fixture operation')
            converted = np.ascontiguousarray(array).tobytes()
            if target.tell() != segment['offset'] or len(converted) != segment['bytes'] or int(np.prod(segment['shape'])) * 4 != len(converted):
                raise ValueError('Derived segment bounds mismatch')
            target.write(converted)
    if sha_file(reference) != sha_file(rebuilt):
        raise ValueError('Source recipe reconstruction is not byte-identical')
    validation = fixture_path.with_suffix('.validation')
    if validation.exists():
        raise ValueError('Source fixture validation path already exists')
    shutil.copytree(directory / 'validation', validation)
    print(json.dumps({'sourceFixture': str(fixture_path), 'sourceBytes': total_bytes, 'derivedBytes': reference.stat().st_size, 'derivedSHA256': sha_file(reference), 'byteIdentical': True}), flush=True)

def export_decoder_argmax(directory):
    """Small provider-independent graph; use GPU outputs to avoid per-token reads.

    Abs <= FLT_MAX rejects both NaN and infinities using operators actually
    implemented by ORT WebGPU. Cast to INT64 is deliberately avoided: ORT WebGPU
    ArgMax emits INT64, but its Cast kernel supports FP32/INT32, not INT64.
    """
    import onnx
    from onnx import helper as h, TensorProto as T
    def tensor(name, dtype, dims, values):
        return h.make_tensor(name, dtype, dims, values)
    constants=[tensor('starts',T.INT64,[1],[0]),tensor('ends',T.INT64,[1],[1393]),tensor('axis',T.INT64,[1],[1]),tensor('float_max',T.FLOAT,[],[3.4028234663852886e38]),tensor('negative_inf',T.FLOAT,[],[float('-inf')])]
    nodes=[h.make_node('Slice',['logits','starts','ends','axis'],['legal']),
           h.make_node('Abs',['legal'],['magnitude']),
           h.make_node('LessOrEqual',['magnitude','float_max'],['finite']),
           h.make_node('Where',['finite','legal','negative_inf'],['masked']),
           h.make_node('ArgMax',['masked'],['token'],axis=1,keepdims=1,select_last_index=0),
           h.make_node('Cast',['token'],['token_f32'],to=T.FLOAT),
           h.make_node('Cast',['finite'],['finite_f32'],to=T.FLOAT),
           h.make_node('ReduceMax',['finite_f32','axis'],['valid'],keepdims=1),
           h.make_node('Concat',['token_f32','valid'],['record'],axis=1),
           h.make_node('Concat',['history_in','record'],['history_out'],axis=1)]
    graph=h.make_graph(nodes,'MuscriptorGPUArgMaxHistory',[h.make_tensor_value_info('logits',T.FLOAT,[1,'card']),h.make_tensor_value_info('history_in',T.FLOAT,[1,'history_width'])],[h.make_tensor_value_info('token',T.INT64,[1,1]),h.make_tensor_value_info('history_out',T.FLOAT,[1,'updated_history_width'])],initializer=constants)
    model=h.make_model(graph,producer_name='NoteBlockStudio-Web',opset_imports=[h.make_opsetid('',18)],ir_version=8)
    onnx.checker.check_model(model)
    directory.mkdir(parents=True,exist_ok=True)
    target=directory/'decoder-argmax.onnx';onnx.save(model,target)
    metadata={'kind':'nbs-muscriptor-gpu-token-decoder','version':1,'graph':target.name,'validTokenUpperExclusive':1393,'historyRecord':['token','hasFiniteLegalLogit'],'bytes':target.stat().st_size,'sha256':sha_file(target)}
    (directory/'decoder-argmax.json').write_text(json.dumps(metadata,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(metadata),flush=True)


def export_unrolled_step(source, directory):
    """Clone only nodes 8 times; every learned initializer remains a single ref."""
    import copy
    import onnx
    from onnx import helper as h, TensorProto as T
    source = source.resolve()
    base = onnx.load(source, load_external_data=False)
    decoder = onnx.load(Path(__file__).resolve().parents[1] / 'assets' / 'transcription' / 'common' / 'decoder-argmax.onnx')
    if max(i.version for i in base.opset_import if not i.domain) != 18:
        raise ValueError('The unroll candidate expects the current opset-18 step graph.')
    if any(a.type in (onnx.AttributeProto.GRAPH, onnx.AttributeProto.GRAPHS) for n in base.graph.node for a in n.attribute):
        raise ValueError('Nested source control-flow graphs are not supported by this rewriter.')
    initializer_names={i.name for i in base.graph.initializer}
    if any(n.startswith('nbs_unroll_') for n in initializer_names):
        raise ValueError('Already rewritten or reserved initializer namespace.')
    initializers=[copy.deepcopy(i) for i in base.graph.initializer]
    initializers.append(h.make_tensor('nbs_unroll_one',T.INT64,[1],[1]))
    for original in decoder.graph.initializer:
        value=copy.deepcopy(original);value.name='nbs_unroll_decoder/'+original.name;initializers.append(value)
    nodes=[];records=[];raw_tokens=[];raw_valid=[];first_mapping=None;first_record=None;previous={};position='position';next_token='token';last=None
    for iteration in range(8):
        prefix=f'nbs_unroll_{iteration}/'
        def remap(value):
            if not value:return value
            if value in initializer_names:return value
            if value=='token':return next_token
            if value=='position':return position
            if value.startswith('past_'):return previous.get(value,value)
            return prefix+value
        mapping={}
        for node in base.graph.node:
            new=copy.deepcopy(node);new.name=prefix+(node.name or node.op_type)
            new.input[:]=[remap(v) for v in node.input]
            new.output[:]=[remap(v) for v in node.output]
            nodes.append(new)
        for output in base.graph.output:mapping[output.name]=remap(output.name)
        dprefix=prefix+'decoder/'
        def dmap(value):
            if value=='logits':return mapping['logits']
            if value in {i.name for i in decoder.graph.initializer}:return 'nbs_unroll_decoder/'+value
            return dprefix+value if value else value
        for node in decoder.graph.node:
            if node.output[0]=='history_out':continue
            new=copy.deepcopy(node);new.name=dprefix+(node.name or node.output[0])
            new.input[:]=[dmap(v) for v in node.input];new.output[:]=[dmap(v) for v in node.output];nodes.append(new)
        records.append(dmap('record'));raw_tokens.append(dmap('token'));raw_valid.append(dmap('valid'));next_token=dmap('token')
        if iteration==0:first_mapping=dict(mapping);first_record=dmap('record')
        previous={name.replace('present_','past_',1):value for name,value in mapping.items() if name.startswith('present_')}
        last=mapping
        if iteration<7:
            updated=prefix+'next_position';nodes.append(h.make_node('Add',[position,'nbs_unroll_one'],[updated]));position=updated
    # WebGPU guarantees only 8 storage bindings: 8 inputs plus one output
    # exceeds that floor. Binary Concat nodes use at most 3. Add-zero barriers
    # prevent an optimizer merging the tree back into the failing 8-input op.
    initializers.append(h.make_tensor('nbs_unroll_history_zero',T.FLOAT,[],[0.0]))
    level=0
    while len(records)>1:
        reduced=[]
        for index in range(0,len(records),2):
            combined=f'nbs_unroll_history_{level}_{index}'
            final=len(records)==2
            name='token_history' if final else combined
            nodes.append(h.make_node('Concat',records[index:index+2],[name],axis=1))
            if not final:
                barrier=combined+'_barrier';nodes.append(h.make_node('Add',[combined,'nbs_unroll_history_zero'],[barrier]));name=barrier
            reduced.append(name)
        records=reduced;level+=1
    for output in base.graph.output:nodes.append(h.make_node('Identity',[last[output.name]],[output.name]))
    nodes.append(h.make_node('Identity',[first_mapping['logits']],['first_logits']))
    nodes.append(h.make_node('Identity',[first_record],['first_record']))
    # Formal raw outputs pin each INT64 ArgMax result for the entire graph run,
    # and bypass INT64-to-FP32 Cast / packed history for CPU control decisions.
    raw_outputs=[]
    for index,(token,valid) in enumerate(zip(raw_tokens,raw_valid)):
        nodes.append(h.make_node('Identity',[token],[f'token_{index}']))
        nodes.append(h.make_node('Identity',[valid],[f'valid_{index}']))
        raw_outputs.extend((h.make_tensor_value_info(f'token_{index}',T.INT64,[1,1]),h.make_tensor_value_info(f'valid_{index}',T.FLOAT,[1,1])))
    graph=h.make_graph(nodes,'MuscriptorGreedyStep8',list(base.graph.input),[*raw_outputs,h.make_tensor_value_info('token_history',T.FLOAT,[1,16]),h.make_tensor_value_info('first_record',T.FLOAT,[1,2]),h.make_tensor_value_info('first_logits',T.FLOAT,list(base.graph.output[0].type.tensor_type.shape.dim[i].dim_value or 'card' for i in range(2))),*list(base.graph.output)],initializer=initializers)
    model=h.make_model(graph,producer_name='NoteBlockStudio-Web',opset_imports=list(base.opset_import),ir_version=base.ir_version)
    names=[node.name for node in nodes if node.name]
    if len(names)!=len(set(names)):raise ValueError('Duplicate node name in unrolled graph.')
    # All external weights are still absent: validate structure using zero-size
    # metadata only, then actual execution is tested with the tiny real fixtures.
    if len([i for i in model.graph.initializer if i.data_location==T.EXTERNAL])!=len([i for i in base.graph.initializer if i.data_location==T.EXTERNAL]):
        raise ValueError('Unrolling duplicated external learned tensors.')
    directory.mkdir(parents=True,exist_ok=True);target=directory/'step8.onnx';onnx.save(model,target)
    external=[{'name':i.name,'dtype':i.data_type,'dims':list(i.dims),'external':{p.key:p.value for p in i.external_data}} for i in initializers if i.data_location==T.EXTERNAL]
    metadata={'kind':'nbs-muscriptor-step-unroll','version':1,'steps':8,'graph':target.name,'bytes':target.stat().st_size,'sha256':sha_file(target),'sourceGraphSHA256':sha_file(source),'externalInitializerCount':len(external),'externalInitializerMetadataSHA256':hashlib.sha256(json.dumps(external,sort_keys=True,separators=(',',':')).encode()).hexdigest(),'weightFilesCopied':False,'historyRecord':['token','hasFiniteLegalLogit']}
    (directory/'step8.json').write_text(json.dumps(metadata,indent=2)+'\n',encoding='utf-8');print(json.dumps(metadata),flush=True)


def main():
    args = arguments()
    if args.unroll_step:
        export_unrolled_step(args.unroll_step,args.output)
        return
    if args.decoder_argmax:
        export_decoder_argmax(args.output)
        return
    try:
        import numpy as np
        import onnx
        import onnxruntime as ort
        import torch
        from torch import nn
        from torch.nn import functional as F
        from safetensors.torch import load_file
    except ImportError as error:
        raise SystemExit('Missing export dependency: ' + str(error) + '. See docs/TRANSCRIPTION-MODELS.md; install only in a local virtual environment.')
    sys.path.insert(0, str(args.upstream))
    from muscriptor.transcription_model import _build_model, _CONFIGS, _ModelConfig, _remap_single_codebook_keys
    from muscriptor.modules.transformer import create_sin_embedding
    from muscriptor.modules.streaming import init_states, increment_steps
    from muscriptor.modules.conditioners import WavCondition
    from muscriptor.tokenizer.mt3 import MT3Tokenizer

    torch.set_num_threads(args.threads)
    torch.manual_seed(123456)
    cfg = _CONFIGS[args.variant]
    if args.dummy:
        cfg = _ModelConfig(dim=128, num_heads=2, num_layers=2, card=cfg.card)
    model = _build_model(torch.device('cpu'), cfg).eval().float()
    if args.source_template:
        # Prevent value-based exporter deduplication from aliasing distinct learned
        # gamma/beta tensors that are all 1/0 in a freshly initialized Transformer.
        with torch.no_grad():
            for name, parameter in model.named_parameters():
                if 'norm' in name and name.endswith('.weight'):
                    parameter.normal_(1.0, 0.02)
                elif name.endswith('.bias'):
                    parameter.normal_(0.0, 0.005)
                else:
                    parameter.normal_(0.0, 0.02)
    if args.weights:
        model.load_state_dict(_remap_single_codebook_keys(load_file(str(args.weights), device='cpu')), strict=True)
    checkpoint_coefficients=bool(args.weights)
    if args.preprocessing_weights:
        from safetensors import safe_open
        prefix='condition_provider.conditioners.self_wav.mel_spec_transform.'
        destinations={'spectrogram.window':model.condition_provider.conditioners['self_wav'].mel_spec_transform.spectrogram.window,'mel_scale.fb':model.condition_provider.conditioners['self_wav'].mel_spec_transform.mel_scale.fb}
        with safe_open(str(args.preprocessing_weights),framework='pt',device='cpu') as checkpoint:
            for suffix,destination in destinations.items():
                value=checkpoint.get_tensor(prefix+suffix)
                if value.dtype!=torch.float32 or tuple(value.shape)!=tuple(destination.shape) or not torch.isfinite(value).all():
                    raise ValueError('Checkpoint preprocessing buffer has an unsupported dtype, shape or numeric value: '+suffix)
                destination.copy_(value)
        checkpoint_coefficients=True
    elif args.source_template and args.dummy_full_size:
        # Models save these fixed mathematical buffers after precision rounding.
        # Regenerating fresh torch coefficients changes trained-model logits.
        # Full-size source exports must bootstrap from exact verified v2 assets,
        # never silently fall back to freshly computed math coefficients.
        folder=Path(__file__).resolve().parents[1]/'assets'/'transcription'/args.variant
        assets=[('window-v2.f32',8192,'0c84bb4f4654fb07efc1d59ed47f697c95a2d242fe19025791d5211265abed8b',model.condition_provider.conditioners['self_wav'].mel_spec_transform.spectrogram.window),('mel-filter-v2.f32',2099200,'a18c6e6e401ede017e9a95400b3742d87073f60df52c92822c18bcb1e86f4fdb',model.condition_provider.conditioners['self_wav'].mel_spec_transform.mel_scale.fb)]
        for name,size,sha,destination in assets:
            source=folder/name
            if not source.is_file() or source.stat().st_size!=size or sha_file(source)!=sha:
                raise ValueError('Missing exact checkpoint coefficient asset; use --preprocessing-weights with the licensed original checkpoint: '+str(source))
            array=np.fromfile(source,dtype='<f4').reshape(tuple(destination.shape));destination.copy_(torch.from_numpy(array.copy()))
        checkpoint_coefficients=True
    preprocessing_names={'window':'window-v2.f32','melFilter':'mel-filter-v2.f32'} if args.source_template and checkpoint_coefficients else {'window':'window.f32','melFilter':'mel-filter.f32'}
    if args.precision == 'fp16':
        model.half()
        model.condition_provider.float()
    torch_rtol, torch_atol = ((1e-2, 3e-2) if args.precision == 'fp16' else (1e-4, 3e-4))
    onnx_rtol, onnx_atol = ((5e-2, 2e-1) if args.precision == 'int8' else (1e-2, 3e-2) if args.precision == 'fp16' else (2e-4, 5e-4))
    conditioners = model.condition_provider.conditioners
    mel_conditioner = conditioners['self_wav']
    layers = len(model.transformer.layers)
    heads = cfg.num_heads
    head_dim = cfg.dim // heads
    prefix_length = 503
    test_only = bool(args.dummy or args.dummy_full_size)

    class DecoderGraph(nn.Module):
        """Explicit tensor KV I/O; no mutable Python streaming state in ONNX."""
        def __init__(self, core, prefill):
            super().__init__()
            self.core = core
            self.prefill = prefill
        def forward(self, *inputs):
            if self.prefill:
                log_mel, tokens = inputs
                audio = self.core.condition_provider.conditioners['self_wav'].output_proj(log_mel)
                # Reference 80,000-sample chunks have 501 STFT frames but length/160=500.
                # The mask is applied after projection, including its bias.
                audio = torch.cat((audio[:, :500], torch.zeros_like(audio[:, 500:501])), dim=1)
                ds = self.core.condition_provider.conditioners['dataset_name'].embed.weight[1].view(1, 1, -1)
                inst = self.core.condition_provider.conditioners['instrument_group'].embed.weight[1].view(1, 1, -1)
                x = torch.cat((audio, ds, inst, self.core.emb(tokens)), dim=1).to(self.core.emb.weight.dtype)
                position = torch.zeros((1,), dtype=torch.long, device=x.device)
                caches = None
            else:
                token, position, *caches = inputs
                x = self.core.emb(token)
            length = x.shape[1]
            positions = torch.arange(length, device=x.device).view(1, -1, 1) + position.view(1, 1, 1)
            positional = create_sin_embedding(positions, cfg.dim, max_period=10000, dtype=torch.float32)
            x = x + positional.to(x.dtype)
            presents = []
            for i, layer in enumerate(self.core.transformer.layers):
                normalized = layer.norm1(x)
                qkv = F.linear(normalized, layer.self_attn.in_proj_weight)
                qkv = qkv.reshape(1, length, 3, heads, head_dim)
                q, key, value = qkv.unbind(dim=2)
                q, key, value = (part.transpose(1, 2) for part in (q, key, value))
                if not self.prefill:
                    key = torch.cat((caches[2 * i].to(key.dtype), key), dim=2)
                    value = torch.cat((caches[2 * i + 1].to(value.dtype), value), dim=2)
                attention = torch.matmul(q, key.transpose(-2, -1)) * (head_dim ** -0.5)
                if self.prefill:
                    index = torch.arange(length, device=x.device)
                    causal = index.view(1, -1) <= index.view(-1, 1)
                    attention = torch.where(causal.view(1, 1, length, length), attention, torch.full_like(attention, float('-inf')))
                attended = torch.matmul(torch.softmax(attention, dim=-1), value)
                attended = attended.transpose(1, 2).reshape(1, length, cfg.dim)
                x = x + layer.self_attn.out_proj(attended)
                x = x + layer.linear2(F.gelu(layer.linear1(layer.norm2(x)), approximate='none'))
                presents.extend((key.float(), value.float()))
            logits = self.core.linear(self.core.out_norm(x[:, -1:, :]))[:, -1, :]
            return (logits.float(), *presents)

    prefill, step = DecoderGraph(model, True).eval(), DecoderGraph(model, False).eval()
    output_names = ['logits'] + [f'present_{kind}_{i}' for i in range(layers) for kind in ('key', 'value')]
    past_names = [f'past_{kind}_{i}' for i in range(layers) for kind in ('key', 'value')]

    # Two reproducible signals exercise reflection padding, quiet log-mel and phase.
    times = torch.arange(80000, dtype=torch.float32) / 16000
    waveform = (0.1 * torch.sin(times * (440 * 2 * torch.pi)) + 0.03 * torch.sin(times * (659.255 * 2 * torch.pi))).view(1, 1, -1)
    log_mel = torch.log(mel_conditioner.mel_spec_transform(waveform).squeeze(1).transpose(1, 2) + 1e-6)
    wav_condition = WavCondition(waveform, torch.tensor([80000]), [16000], [None], [0.0])
    reference_audio = mel_conditioner(wav_condition)
    null = torch.zeros((1, 1), dtype=torch.long)
    conditions = {'instrument_group': conditioners['instrument_group'](null), 'dataset_name': conditioners['dataset_name'](null), 'self_wav': reference_audio}

    validation = {'testOnly': test_only, 'reference': 'official PyTorch full prefill and mutable-KV streaming steps', 'torch': torch.__version__, 'onnxruntime': ort.__version__, 'precision': args.precision, 'torchTolerance': {'rtol': torch_rtol, 'atol': torch_atol}, 'onnxTolerance': {'rtol': onnx_rtol, 'atol': onnx_atol}, 'cases': []}
    first_outputs = None
    with torch.inference_mode():
        for prompt in ([cfg.card], [cfg.card, 2, 100, 1130]):
            tokens = torch.tensor([prompt], dtype=torch.long)
            official_state = init_states(model, batch_size=1, sequence_length=2600)
            official = model(tokens, conditions, first_step=True, model_state=official_state)[:, -1, :].float()
            exported = prefill(log_mel, tokens)
            torch.testing.assert_close(exported[0], official, rtol=torch_rtol, atol=torch_atol)
            for i in range(layers):
                cache = official_state[f'transformer.layers.{i}.self_attn']['cache']
                for j in range(2):
                    original = cache[j, :, :prefix_length + len(prompt)].transpose(1, 2).float()
                    torch.testing.assert_close(exported[1 + 2 * i + j], original, rtol=torch_rtol, atol=torch_atol)
            increment_steps(model.transformer, official_state, prefix_length + len(prompt))
            max_error = float(torch.max(torch.abs(exported[0] - official)))
            caches = exported[1:]
            for iteration in range(3):
                token = torch.argmax(official[:, :1393], dim=-1).view(1, 1)
                position = torch.tensor([prefix_length + len(prompt) + iteration], dtype=torch.long)
                official = model(token, {}, first_step=False, model_state=official_state)[:, -1, :].float()
                increment_steps(model.transformer, official_state, 1)
                exported = step(token, position, *caches)
                torch.testing.assert_close(exported[0], official, rtol=torch_rtol, atol=torch_atol)
                max_error = max(max_error, float(torch.max(torch.abs(exported[0] - official))))
                caches = exported[1:]
            validation['cases'].append({'promptLength': len(prompt), 'cachedSteps': 3, 'torchMaximumAbsoluteError': max_error})
            if first_outputs is None:
                first_outputs = prefill(log_mel, torch.tensor([[cfg.card]], dtype=torch.long))
    print(json.dumps({'stage': 'PyTorch graph parity', 'cases': validation['cases']}), flush=True)

    args.output.mkdir(parents=True, exist_ok=True)
    prefill_dynamic = {'tokens': {1: 'prompt_length'}}
    step_dynamic = {}
    for i in range(layers):
        for kind in ('key', 'value'):
            prefill_dynamic[f'present_{kind}_{i}'] = {2: 'prefill_length'}
            step_dynamic[f'past_{kind}_{i}'] = {2: 'past_length'}
            step_dynamic[f'present_{kind}_{i}'] = {2: 'present_length'}
    with torch.inference_mode():
        torch.onnx.export(prefill, (log_mel, torch.tensor([[cfg.card]], dtype=torch.long)), str(args.output / 'prefill.onnx'), input_names=['log_mel', 'tokens'], output_names=output_names, dynamic_axes=prefill_dynamic, opset_version=18, do_constant_folding=True, dynamo=False, external_data=False)
        torch.onnx.export(step, (torch.tensor([[123]], dtype=torch.long), torch.tensor([504]), *first_outputs[1:]), str(args.output / 'step.onnx'), input_names=['token', 'position', *past_names], output_names=output_names, dynamic_axes=step_dynamic, opset_version=18, do_constant_folding=True, dynamo=False, external_data=False)

    if args.precision == 'int8':
        from onnxruntime.quantization import QuantType, quantize_dynamic
        for graph_name in ('prefill.onnx', 'step.onnx'):
            graph_path = args.output / graph_name
            temporary = args.output / (graph_name + '.int8')
            quantize_dynamic(str(graph_path), str(temporary), per_channel=True, weight_type=QuantType.QInt8, op_types_to_quantize=['MatMul'], extra_options={'MatMulConstBOnly': True})
            temporary.replace(graph_path)

    if args.source_template:
        source_map = export_source_mapping(args.output, model, onnx, np)
    else:
        # Both graphs reference one checked weights file; identical tensors are stored once.
        # This saves download/storage, although two sessions still own their GPU allocations.
        offsets = {}
        with (args.output / 'weights.bin').open('wb') as data:
            for name in ('prefill.onnx', 'step.onnx'):
                graph_path = args.output / name
                graph = onnx.load(str(graph_path), load_external_data=False)
                for tensor in graph.graph.initializer:
                    if tensor.HasField('raw_data') and len(tensor.raw_data) >= 1024:
                        raw = tensor.raw_data
                        key = (tensor.data_type, tuple(tensor.dims), hashlib.sha256(raw).hexdigest())
                        if key not in offsets:
                            offsets[key] = (data.tell(), len(raw))
                            data.write(raw)
                        offset, size = offsets[key]
                        onnx.external_data_helper.set_external_data(tensor, location='weights.bin', offset=offset, length=size)
                        tensor.ClearField('raw_data')
                onnx.save_model(graph, str(graph_path))

    mel_conditioner.mel_spec_transform.spectrogram.window.detach().numpy().astype('<f4').tofile(args.output / preprocessing_names['window'])
    mel_conditioner.mel_spec_transform.mel_scale.fb.detach().numpy().astype('<f4').tofile(args.output / preprocessing_names['melFilter'])
    validation_dir = args.output / 'validation'
    validation_dir.mkdir()
    waveform.numpy().astype('<f4').tofile(validation_dir / 'audio-16000.f32')
    log_mel.detach().numpy().astype('<f4').tofile(validation_dir / 'log-mel.f32')
    # Compact reference fixtures for browser FFT/filterbank/resampler tests.
    rng = np.random.default_rng(4321)
    noisy = torch.from_numpy((rng.standard_normal(1600) * 0.03).astype(np.float32))
    padded_noisy = F.pad(noisy, (0, 80000 - noisy.numel())).view(1, 1, -1)
    noisy_mel = torch.log(mel_conditioner.mel_spec_transform(padded_noisy).squeeze(1).transpose(1, 2) + 1e-6)
    noisy.numpy().astype('<f4').tofile(validation_dir / 'noise-100ms-16000.f32')
    noisy_mel.numpy().astype('<f4').tofile(validation_dir / 'noise-padded-log-mel.f32')
    from muscriptor.utils.resample import resample_frac
    resample_time = torch.arange(4410, dtype=torch.float32) / 44100
    resample_input = (0.1 * torch.sin(resample_time * (440 * 2 * torch.pi)) + 0.03 * torch.sin(resample_time * (997 * 2 * torch.pi)))
    resample_output = resample_frac(resample_input, 44100, 16000)
    resample_input.numpy().astype('<f4').tofile(validation_dir / 'resample-input-44100.f32')
    resample_output.numpy().astype('<f4').tofile(validation_dir / 'resample-output-16000.f32')
    (validation_dir / 'preprocessing.json').write_text(json.dumps({'dtype': 'little-endian float32', 'waveform': 'audio-16000.f32', 'logMel': 'log-mel.f32', 'logMelShape': [1, 501, 512], 'quietLogMel': float(torch.log(torch.tensor(1e-6))), 'noise': {'waveform': 'noise-100ms-16000.f32', 'samples': 1600, 'padRightTo': 80000, 'logMel': 'noise-padded-log-mel.f32'}, 'resample': {'input': 'resample-input-44100.f32', 'output': 'resample-output-16000.f32', 'inputRate': 44100, 'outputRate': 16000, 'inputSamples': 4410, 'outputSamples': int(resample_output.numel()), 'reference': 'official Julius resample_frac; zeros=24, rolloff=0.945'}}, indent=2) + '\n', encoding='utf-8')


    if not args.skip_onnx_validation:
        session_options = ort.SessionOptions()
        session_options.intra_op_num_threads = args.threads
        session_options.inter_op_num_threads = 1
        prefill_session = ort.InferenceSession(str(args.output / 'prefill.onnx'), sess_options=session_options, providers=['CPUExecutionProvider'])
        step_session = ort.InferenceSession(str(args.output / 'step.onnx'), sess_options=session_options, providers=['CPUExecutionProvider'])
        golden = {}
        for prompt in ([cfg.card], [cfg.card, 2, 100, 1130]):
            tokens = torch.tensor([prompt], dtype=torch.long)
            with torch.inference_mode():
                expected = prefill(log_mel, tokens)
            actual = prefill_session.run(None, {'log_mel': log_mel.numpy(), 'tokens': tokens.numpy()})
            max_error = 0.0
            for a, b in zip(actual, expected):
                np.testing.assert_allclose(a, b.numpy(), rtol=onnx_rtol, atol=onnx_atol)
                max_error = max(max_error, float(np.max(np.abs(a - b.numpy()))))
            if len(prompt) == 1:
                golden['prefillLogits'] = actual[0].ravel().tolist()
            for iteration in range(3):
                token = np.argmax(actual[0][:, :1393], axis=-1).astype(np.int64).reshape(1, 1)
                position = np.array([prefix_length + len(prompt) + iteration], dtype=np.int64)
                feed = {'token': token, 'position': position, **dict(zip(past_names, actual[1:]))}
                with torch.inference_mode():
                    expected = step(torch.from_numpy(token), torch.from_numpy(position), *[torch.from_numpy(a) for a in actual[1:]])
                actual = step_session.run(None, feed)
                for a, b in zip(actual, expected):
                    np.testing.assert_allclose(a, b.numpy(), rtol=onnx_rtol, atol=onnx_atol)
                    max_error = max(max_error, float(np.max(np.abs(a - b.numpy()))))
            validation['cases'][0 if len(prompt) == 1 else 1]['onnxMaximumAbsoluteError'] = max_error
        (validation_dir / 'golden.json').write_text(json.dumps(golden) + '\n', encoding='utf-8')
        validation['onnxVerified'] = True
    else:
        validation['onnxVerified'] = False
    (validation_dir / 'parity.json').write_text(json.dumps(validation, indent=2) + '\n', encoding='utf-8')
    tokenizer = MT3Tokenizer(instrument_vocabulary='MT3_FULL_PLUS', max_shift_steps=1001)
    (validation_dir / 'tokenizer.json').write_text(json.dumps({'vocabulary': [{'type': event.type, 'value': event.value} for event in tokenizer._vocab], 'groupPrograms': tokenizer.group_program_map, 'eos': tokenizer.eos_id, 'frameRate': tokenizer.frame_rate}, separators=(',', ':')) + '\n', encoding='utf-8')

    shutil.copyfile(args.upstream / 'LICENSE', args.output / 'LICENSE-upstream.txt')
    (args.output / 'MODEL-LICENSE.txt').write_text(('No pretrained model weights are included in this source template. Downloaded MuScriptor weights are CC BY-NC 4.0.\n' if args.source_template else 'Random weights: TEST ONLY, not a music transcription model.\n' if test_only else 'MuScriptor model weights are CC BY-NC 4.0, separate from the MIT source code.\n') + 'https://huggingface.co/MuScriptor\nhttps://creativecommons.org/licenses/by-nc/4.0/\n', encoding='utf-8')
    try:
        revision = subprocess.check_output(['git', '-C', str(args.upstream), 'rev-parse', 'HEAD'], text=True, stderr=subprocess.DEVNULL).strip()
    except (OSError, subprocess.CalledProcessError):
        revision = None
    files = [{'path': file.relative_to(args.output).as_posix(), 'bytes': file.stat().st_size, 'sha256': sha_file(file)} for file in sorted(args.output.rglob('*')) if file.is_file()]
    manifest = {'kind': 'nbs-muscriptor-onnx', 'version': 1, 'id': f'muscriptor-{args.variant}-' + ('test-' if test_only else '') + args.precision, 'variant': args.variant, 'sampleRate': 16000, 'chunkSamples': 80000, 'melFrames': 501, 'melBins': 512, 'prefixLength': prefix_length, 'card': cfg.card, 'layers': layers, 'heads': heads, 'headDim': head_dim, 'maxTokens': 2000, 'bos': cfg.card, 'validTokenUpperExclusive': 1393, 'graphs': {'prefill': 'prefill.onnx', 'step': 'step.onnx'}, 'externalData': ['weights.bin'], 'preprocessing': preprocessing_names, 'preprocessingVersion': 2 if checkpoint_coefficients else 1, 'preprocessingRevision': 2 if checkpoint_coefficients else 1, 'preprocessingProvenance': 'exact-checkpoint-buffers' if checkpoint_coefficients else 'fresh-generated-test-coefficients', 'precision': args.precision, 'eligibleBackends': ['wasm'] if args.precision == 'int8' else ['webgpu'] if args.precision == 'fp16' else ['webgpu', 'webnn', 'wasm'], 'validatedBackends': [], 'nativeCPUVerified': validation['onnxVerified'], 'testOnly': test_only, 'onnxVerified': validation['onnxVerified'], 'upstream': {'repository': 'https://github.com/muscriptor/muscriptor', 'revision': revision}, 'weightsSHA256': sha_file(args.weights) if args.weights else None, 'files': files}
    if args.source_template:
        # Test assets live outside the static template, never below assets/transcription.
        if args.source_fixture:
            write_source_fixture(args.source_fixture, args.output, model, source_map, np)
        weights_file = args.output / 'weights.bin'
        if weights_file.parent != args.output or weights_file.is_symlink():
            raise ValueError('Unsafe generated external-data target')
        weights_file.unlink()
        if validation_dir.parent != args.output or validation_dir.is_symlink():
            raise ValueError('Unsafe generated validation target')
        shutil.rmtree(validation_dir)
        static_files = [{'path': file.relative_to(args.output).as_posix(), 'bytes': file.stat().st_size, 'sha256': sha_file(file)} for file in sorted(args.output.rglob('*')) if file.is_file()]
        manifest['files'] = static_files
        manifest['testOnly'] = bool(args.dummy)
        manifest['id'] = f'muscriptor-{args.variant}-' + ('test-' if args.dummy else '') + 'fp32-source'
        manifest['weightsSHA256'] = None
        manifest['graphValidationUsedRandomWeights'] = True
        manifest = {'kind': 'nbs-muscriptor-source-onnx', 'version': 1, 'variant': args.variant, 'mapping': 'source-map.json', 'runtimeTemplate': manifest, 'files': static_files, 'derivedAssets': [{'path': 'weights.bin', 'bytes': source_map['target']['bytes']}], 'testOnly': bool(args.dummy), 'graphValidationUsedRandomWeights': True}
    (args.output / 'model.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'package': str(args.output), 'testOnly': manifest['testOnly'], 'onnxVerified': validation['onnxVerified'], 'bytes': sum(f['bytes'] for f in manifest['files']), 'files': len(manifest['files']), 'cases': validation['cases']}), flush=True)


if __name__ == '__main__':
    main()
