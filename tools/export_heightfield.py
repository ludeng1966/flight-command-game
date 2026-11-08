"""Export the actual LandMesh/HM2 height grid for the browser (no contour reconstruction)."""
import argparse
import ctypes
import json
import sys
from pathlib import Path

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--library',required=True)
    ap.add_argument('--level',required=True)
    ap.add_argument('--oodle-core',required=True)
    args=ap.parse_args()
    sys.path.insert(0,args.library)
    import wt_hmap
    dll=ctypes.CDLL(args.oodle_core)
    fn=dll.OodleLZ_Decompress
    fn.restype=ctypes.c_int64
    fn.argtypes=[ctypes.c_void_p,ctypes.c_int64,ctypes.c_void_p,ctypes.c_int64,
        ctypes.c_int,ctypes.c_int,ctypes.c_int,ctypes.c_void_p,ctypes.c_int64,
        ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,ctypes.c_int64,ctypes.c_int]
    def decompress(src,size):
        output=ctypes.create_string_buffer(size)
        actual=fn(src,len(src),output,size,1,0,0,None,0,None,None,None,0,3)
        if actual!=size:raise RuntimeError(f'Oodle decoded {actual}, expected {size}')
        return output.raw
    wt_hmap.oodle_decompress=decompress
    from wt_maps import load_map_heightmap
    heights,info=load_map_heightmap(args.level,max_dim=1024)
    out=Path(__file__).resolve().parents[1]/'terrain'
    name=Path(args.level).stem
    heights.astype('<f4').tofile(out/f'{name}_height.f32')
    meta=dict(width=info.width,height=info.height,originEast=info.ofs_x,originNorth=info.ofs_y,
        step=info.cell_size,rowZero='minNorth',source=info.source,waterLevel=0,
        min=float(heights.min()),max=float(heights.max()),data=f'{name}_height.f32')
    (out/f'{name}_height.json').write_text(json.dumps(meta,indent=2),encoding='utf-8')
    print(json.dumps(meta))

if __name__=='__main__':main()
