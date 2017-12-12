import * as path from 'path';
import * as log from './util/log';
import { ensureUnixPath } from './util/path';
import { rimraf } from './util/rimraf';

// Domain
import { Artefacts } from './domain/build-artefacts';
import { NgEntryPoint, NgPackage } from './domain/ng-package-format';

// Build steps
import { writePackage } from './steps/package';
import { processAssets } from './steps/assets';
import { ngc, prepareTsConfig, analyseSourceFiles, inlineTemplatesAndStyles } from './steps/ngc';
import { minifyJsFile } from './steps/uglify';
import { remapSourceMap, relocateSourceMapSources } from './steps/sorcery';
import { rollup } from './steps/rollup';
import { downlevelWithTsc } from './steps/tsc';
import { copySourceFilesToDestination } from './steps/transfer';
import { BuildStep } from './domain/build-step';

/**
 * Transforms TypeScript source files to Angular Package Format.
 *
 * @param entryPoint The entry point that will be transpiled to a set of artefacts.
 */
export const transformSources: BuildStep =
  async (args): Promise<void | any> => {
    const { artefacts, entryPoint, pkg } = args;
    entryPoint.buildStatus = 'inprogress';
    log.info(`Building from sources for entry point '${entryPoint.moduleId}'`);

    // 0. CLEAN BUILD DIRECTORY
    log.info('Cleaning build directory');
    await rimraf(artefacts.outDir);
    await rimraf(artefacts.stageDir);

    // 1. TWO-PASS TSC TRANSFORMATION
    prepareTsConfig(args);

    // First pass: extract templateUrl and styleUrls, analyse dependencies
    analyseSourceFiles(args);

    // XX: here starts the real work :-)
    if (entryPoint.dependendingOnEntryPoints.length > 0) {
      log.info(`${entryPoint.moduleId} depends on ${entryPoint.dependendingOnEntryPoints.join(', ')}.`);

      // Were the depending entry points already built?
      const unsatisfiedDependencies = entryPoint.dependendingOnEntryPoints
        .filter((moduleId) => pkg.entryPoint(moduleId).buildStatus !== 'success');
      if (unsatisfiedDependencies.length > 0) {
        // No: skip this entry point, build the dependee entry point first
        log.warn(`Need to build ${unsatisfiedDependencies.join(', ')} first.`);
        return Promise.resolve('dependencies-not-satisfied');
        // TODO: resume the entry point's build at this state...
      } else {
        // Yes: adjust `compilerOptions.paths`
        if (!artefacts.tsConfig.options.paths) {
          artefacts.tsConfig.options.paths = {};
        }
        for (const dependency of entryPoint.dependendingOnEntryPoints) {
          artefacts.tsConfig.options.paths[dependency] = [ pkg.entryPoint(dependency).destinationPath ];
        }
      }
    }

    // Then, process assets keeping transformed contents in memory.
    log.info('Processing assets');
    await processAssets(args);

    // Second pass: inline templateUrl and styleUrls
    log.info('Inlining templateUrl and styleUrls');
    inlineTemplatesAndStyles(args);

    // 2. NGC
    log.info('Compiling with ngc');
    const tsOutput = await ngc(entryPoint, artefacts);

    // 3. FESM15: ROLLUP
    log.info('Bundling to FESM15');
    const fesm15File = path.resolve(artefacts.stageDir, 'esm2015', entryPoint.flatModuleFile + '.js');
    await rollup({
      moduleName: entryPoint.moduleId,
      entry: tsOutput.js,
      format: 'es',
      dest: fesm15File,
      externals: entryPoint.externals
    });
    await remapSourceMap(fesm15File);

    // 4. FESM5: TSC
    log.info('Bundling to FESM5');
    const fesm5File = path.resolve(artefacts.stageDir, 'esm5', entryPoint.flatModuleFile + '.js');
    await downlevelWithTsc(fesm15File, fesm5File);
    await remapSourceMap(fesm5File);

    // 5. UMD: ROLLUP
    log.info('Bundling to UMD');
    const umdFile = path.resolve(artefacts.stageDir, 'bundles', entryPoint.flatModuleFile + '.umd.js');
    await rollup({
      moduleName: entryPoint.umdModuleId,
      entry: fesm5File,
      format: 'umd',
      dest: umdFile,
      externals: entryPoint.externals
    });
    await remapSourceMap(umdFile);

    // 6. UMD: Minify
    log.info('Minifying UMD bundle');
    const minUmdFile: string = await minifyJsFile(umdFile);
    await remapSourceMap(minUmdFile);

    // 7. SOURCEMAPS: RELOCATE ROOT PATHS
    log.info('Remapping source maps');
    await relocateSourceMapSources({ artefacts, entryPoint });

    // 8. COPY SOURCE FILES TO DESTINATION
    log.info('Copying staged files');
    // TODO: doesn't work any more
    await copySourceFilesToDestination({ artefacts, entryPoint, pkg });

    // 9. WRITE PACKAGE.JSON
    log.info('Writing package metadata');
    // TODO: doesn't work any more .... path.relative(secondary.basePath, primary.basePath);
    const relativeDestPath: string = path.relative(entryPoint.destinationPath, pkg.primary.destinationPath);
    await writePackage(entryPoint, {
      main: ensureUnixPath(path.join(relativeDestPath, 'bundles', entryPoint.flatModuleFile + '.umd.js')),
      module: ensureUnixPath(path.join(relativeDestPath, 'esm5', entryPoint.flatModuleFile + '.js')),
      es2015: ensureUnixPath(path.join(relativeDestPath, 'esm2015', entryPoint.flatModuleFile + '.js')),
      typings: ensureUnixPath(`${entryPoint.flatModuleFile}.d.ts`),
      // XX 'metadata' property in 'package.json' is non-standard. Keep it anyway?
      metadata: ensureUnixPath(`${entryPoint.flatModuleFile}.metadata.json`)
    });

    entryPoint.buildStatus = 'success';
    log.success(`Built ${entryPoint.moduleId}`);
  }
