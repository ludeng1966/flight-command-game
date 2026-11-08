"""Export an effective aircraft profile from a local unpacked FM.

python tools/export_flight_profiles.py --fm path/to/f-86a-5.blkx
python tools/export_flight_profiles.py --aircraft f16 --fm path/to/f_16a_block_10.blkx
The whole-aircraft cd0, flight mass and control rates are prototype parameters.
ThrustMax0 is interpreted as kgf; the runtime table is converted to newtons.
"""
import argparse
import json
import math
from pathlib import Path

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--fm',required=True)
    parser.add_argument('--aircraft',choices=['f86','f16'],default='f86')
    args=parser.parse_args()
    d=json.loads(Path(args.fm).read_text(encoding='utf-8'))
    wing=d['Aerodynamics']['WingPlane'];polar=wing['FlapsPolar0']
    area=sum(wing['Areas'][s+p] for s in ['Left','Right'] for p in ['In','Mid','Out'])
    t=d['EngineType0']['Main']['ThrustMax']
    alt=[t[key] for key in sorted((k for k in t if k.startswith('Altitude_')),key=lambda k:int(k.split('_')[1]))]
    speeds=[t[key]/3.6 for key in sorted((k for k in t if k.startswith('Velocity_')),key=lambda k:int(k.split('_')[1]))]
    f16=args.aircraft=='f16'
    profile=dict(name='F-16A Block 10' if f16 else 'F-86A-5',mass=10000 if f16 else 7000,area=area,cl0=polar['Cl0'],
        clAlpha=polar['lineClCoeff']*180/math.pi,clMax=polar['ClCritHigh'],
        cd0=.020 if f16 else .024,k=area/(math.pi*polar['OswaldsEfficiencyNumber']*wing['Span']**2),
        maxG=9 if f16 else 4.5,bankRate=math.radians(120 if f16 else 45),clRate=1.2 if f16 else .65,
        thrust=dict(altitudes=alt,speeds=speeds,values=[
            [t['ThrustMax0']*9.80665*t[f'ThrustMaxCoeff_{i}_{j}'] for j in range(len(speeds))] for i in range(len(alt))]),
        provenance=dict(source=f'Local War Thunder FM / {Path(args.fm).name}',
            scope='Effective subsonic point-mass prototype; not the complete aircraft FM',
            assumptions=('10000 kg fixed flight mass; cd0=.020; 9 G normal limit; 120 deg/s bank response; 1.2/s CL response; dry thrust only; no afterburner or Mach corrections; thrust base interpreted as kgf; control limits selected for prototype' if f16 else '7000 kg flight mass; cd0=.024; thrust base interpreted as kgf; control limits selected for prototype')))
    if f16:
        engine=d['EngineType0']['Main']
        profile['engine']=dict(dryBoost=engine['ThrottleBoost']*engine['Mode4']['ThrustMult'],
            wetBoost=engine['AfterburnerBoost']*engine['Mode5']['ThrustMult'],
            responseSeconds=engine['TurbineTimeConstant'],
            afterburnerCoefficients=[[t[f'ThrAftMaxCoeff_{i}_{j}'] for j in range(len(speeds))] for i in range(len(alt))])
        profile['engine']['dryModes']=[dict(throttle=engine[f'Mode{i}']['Throttle'],fraction=engine[f'Mode{i}']['ThrustMult']/engine['Mode4']['ThrustMult']) for i in range(5)]
        profile['machPolar']={str(i):dict(critical=polar[f'MachCrit{i}'],peakMach=polar[f'MachMax{i}'],
            peak=polar[f'MultMachMax{i}'],slope=polar[f'MultLineCoeff{i}'],limit=polar[f'MultLimit{i}']) for i in [1,2,3,5]}
        fuse=d['Aerodynamics']['FuselagePlane']
        profile['waveDrag']=[dict(cd=polar['CdMin'],factor=profile['machPolar']['1']),
            dict(cd=fuse['Polar']['CdMin']*fuse['Areas']['Main']/area,
                 factor=dict(critical=fuse['Polar']['MachCrit1'],peakMach=fuse['Polar']['MachMax1'],peak=fuse['Polar']['MultMachMax1'],slope=fuse['Polar']['MultLineCoeff1'],limit=fuse['Polar']['MultLimit1']))]
        profile['limits']=dict(mach=wing['Strength']['MNE'],ias=wing['Strength']['VNE']/3.6)
        profile['provenance']['scope']='Effective point-mass FM with smoothly blended Mach polar and afterburner tables; not the original War Thunder solver'
        profile['provenance']['assumptions']='10000 kg fixed mass; cd0=.020; 9 G limit; 120 deg/s roll and 1.2/s CL response. Mach factors 1/2/3/5 interpreted as drag/slope/critical-lift/critical-AoA; cubic blending and post-peak continuation are prototype approximations. Thrust base interpreted as kgf; dry/wet mode multipliers applied to existing tables. No fuel burn or original multi-surface six-DOF solver.'
    out=Path(__file__).resolve().parents[1]/'data/aircraft.json'
    profiles=json.loads(out.read_text(encoding='utf-8')) if out.exists() else {}
    profiles[args.aircraft]=profile
    out.write_text(json.dumps(profiles,indent=2),encoding='utf-8')
    print(out)

if __name__=='__main__':main()
