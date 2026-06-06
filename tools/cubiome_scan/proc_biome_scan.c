/* proc_biome_scan — offline biome disc histogram for mapcatalog Pass 1. */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <stdint.h>

#include "generator.h"
#include "biomenoise.h"
#include "util.h"

static int parse_mc(const char *s)
{
    if (!s || !*s)
        return MC_UNDEF;
    if (!strcmp(s, "MC_1_21") || !strcmp(s, "MC_1_21_WD"))
        return MC_1_21;
    if (!strcmp(s, "MC_1_21_3"))
        return MC_1_21_3;
    if (!strcmp(s, "MC_1_21_1"))
        return MC_1_21_1;
    if (!strcmp(s, "MC_1_20"))
        return MC_1_20;
    if (!strncmp(s, "MC_", 3))
        return str2mc(s + 3); /* MC_1_19 -> 1_19 won't work; prefer explicit flags */
    return str2mc(s);
}

static void usage(const char *prog)
{
    fprintf(stderr,
        "usage: %s --seed SEED --center CX,CZ --radius R [--step S] [--mc MC_1_21]\n",
        prog);
}

static int parse_i64(const char *s, int64_t *out)
{
    char *end = NULL;
    long long v = strtoll(s, &end, 10);
    if (end == s || (end && *end))
        return -1;
    *out = (int64_t)v;
    return 0;
}

int main(int argc, char **argv)
{
    const char *seed_s = NULL;
    const char *center_s = NULL;
    const char *mc_s = "MC_1_21";
    int radius = 64;
    int step = 16;
    int cx = 0, cz = 0;

    for (int i = 1; i < argc; i++)
    {
        if (!strcmp(argv[i], "--seed") && i + 1 < argc)
            seed_s = argv[++i];
        else if (!strcmp(argv[i], "--center") && i + 1 < argc)
            center_s = argv[++i];
        else if (!strcmp(argv[i], "--radius") && i + 1 < argc)
            radius = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--step") && i + 1 < argc)
            step = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--mc") && i + 1 < argc)
            mc_s = argv[++i];
        else
        {
            usage(argv[0]);
            return 2;
        }
    }

    if (!seed_s || !center_s)
    {
        usage(argv[0]);
        return 2;
    }

    if (sscanf(center_s, "%d,%d", &cx, &cz) != 2)
    {
        fprintf(stderr, "invalid --center (want CX,CZ)\n");
        return 2;
    }

    int64_t seed_i64;
    if (parse_i64(seed_s, &seed_i64))
    {
        fprintf(stderr, "invalid --seed\n");
        return 2;
    }

    int mc = parse_mc(mc_s);
    if (mc == MC_UNDEF)
    {
        fprintf(stderr, "unknown --mc %s\n", mc_s);
        return 2;
    }

    Generator g;
    setupGenerator(&g, mc, 0);
    applySeed(&g, DIM_OVERWORLD, (uint64_t)seed_i64);

    SurfaceNoise sn;
    initSurfaceNoise(&sn, DIM_OVERWORLD, (uint64_t)seed_i64);

    const int max_cells = 8192;
    int cell_count = 0;
    int r2 = radius * radius;

    printf("{\n");
    printf("  \"mc\": \"%s\",\n", mc_s);
    printf("  \"seed\": \"%s\",\n", seed_s);
    printf("  \"center\": [%d, %d],\n", cx, cz);
    printf("  \"radius\": %d,\n", radius);
    printf("  \"step\": %d,\n", step);
    printf("  \"cells\": [\n");

    int first = 1;
    for (int x = cx - radius; x <= cx + radius; x += step)
    {
        for (int z = cz - radius; z <= cz + radius; z += step)
        {
            if ((x - cx) * (x - cx) + (z - cz) * (z - cz) > r2)
                continue;
            if (cell_count >= max_cells)
                break;

            float yf = 0;
            int bid = none;
            mapApproxHeight(&yf, NULL, &g, &sn, x, z, 1, 1);
            int y3 = (int)floorf(yf);
            if (y3 < -64)
                y3 = -64;
            if (y3 > 319)
                y3 = 319;
            bid = getBiomeAt(&g, 1, x, y3, z);
            const char *bname = biome2str(mc, bid);
            if (!bname)
                bname = "unknown";

            if (!first)
                printf(",\n");
            first = 0;
            printf("    {\"x\": %d, \"z\": %d, \"y\": %.1f, \"biome\": \"%s\"}", x, z, yf, bname);
            cell_count++;
        }
    }

    printf("\n  ],\n");
    printf("  \"cell_count\": %d\n", cell_count);
    printf("}\n");
    return 0;
}
