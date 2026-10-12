import os, stat, sys
os.chmod(os.path.join(sys.argv[1], 'assets', 'licence.txt'), stat.S_IREAD)
