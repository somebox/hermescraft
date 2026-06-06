# Build proc_biome_scan against vendored cubiomes (clone first).
#   git clone --depth 1 https://github.com/Cubitect/cubiomes.git cubiomes
#   make -C tools/cubiome_scan

CUBIOMES := cubiomes
CC       := cc
CFLAGS   := -Wall -Wextra -O2 -I$(CUBIOMES)
LDFLAGS  := -lm -pthread

.PHONY: all clean

all: proc_biome_scan

cubiomes-lib:
	$(MAKE) -C $(CUBIOMES) release

proc_biome_scan: proc_biome_scan.c cubiomes-lib
	$(CC) $(CFLAGS) -o $@ proc_biome_scan.c $(CUBIOMES)/libcubiomes.a $(LDFLAGS)

clean:
	rm -f proc_biome_scan
	$(MAKE) -C $(CUBIOMES) clean
