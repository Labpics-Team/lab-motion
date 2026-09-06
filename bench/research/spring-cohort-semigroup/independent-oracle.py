import json
from pathlib import Path
import mpmath as mp
import sympy as sp
mp.mp.dps=80
w,z=sp.symbols('w z',positive=True)
A=sp.Matrix([[0,1],[-w*w,-2*z*w]])
G=sp.diag(1,1/w**2)
identity=sp.simplify(A.T*G+G*A)
assert identity==sp.diag(0,-4*z/w)
# An independent matrix exponential IVP, rather than production modal formulas.
M=mp.matrix([[0,1],[-400,-800]])
t=mp.mpf(1)/1000
initial=mp.matrix([-1,0]);u=mp.expm(M*t)*initial
result={'dissipation':str(identity),'witness':{'mass':1,'stiffness':400,'damping':800,'t':'1/1000','span':100,'x':str(100*(1+u[0])),'velocity':str(100*u[1])},'reverseSpectralAmplificationOver99ms':str(mp.exp((400+mp.sqrt(400**2-400))*mp.mpf(99)/1000))}
# Every entry of Phi(h) is independently checked against the product law.
maximum=mp.mpf(0)
for damping in ('0.1','0.5','0.999999','1','1.000001','2','20'):
 a=mp.matrix([[0,1],[-400,-40*mp.mpf(damping)]])
 for t,h in ((mp.mpf('.001'),mp.mpf('.001')),(mp.mpf('.1'),mp.mpf('.099')),(mp.mpf('.3'),mp.mpf('.05'))):
  error=mp.norm(mp.expm(a*(t+h))-mp.expm(a*t)*mp.expm(a*h),p=mp.inf)
  maximum=max(maximum,error)
assert maximum<mp.mpf('1e-70')
result['semigroupMaxMatrixResidual80digit']=str(maximum)
Path(__file__).with_name('independent-oracle.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
controls=json.loads(Path(__file__).with_name('controls.json').read_text())
# Convert exact binary64 inputs to rationals before high-precision arithmetic.
def exact_float(v):
 n,d=float(v).as_integer_ratio();return mp.mpf(n)/d
anchor=controls['anchor']
rounded=mp.matrix([exact_float(anchor['H']),exact_float(anchor['J'])])
ideal_inverse=mp.expm(-M*(mp.mpf(99)/1000))*rounded
recovered=100*(1-(ideal_inverse[1]+800*ideal_inverse[0]))
result['exactInverseOfRoundedAnchorX']=str(recovered)
result['exactInverseRoundedAnchorErrorPx']=str(abs(recovered-100*(1+u[0])))
assert abs(recovered-100*(1+u[0]))>1
Path(__file__).with_name('independent-oracle.json').write_text(json.dumps(result,indent=2)+'\n')
print('rounded anchor, even with 80-digit inverse:',recovered)
