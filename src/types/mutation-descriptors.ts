/**
 * Side-effect descriptors produced by mutation workflows and replayed as
 * Socket.IO events by the main process after the workflow run completes.
 *
 * Kept in src/types/ so both the workflow bundle and the main-process adapter
 * can import it without pulling heavy runtime code into either side.
 */

export type MutationDescriptor =
  | {
      type: "addDeriveAsset";
      data: {
        id: number;
        assetsId: number;
        projectId: number;
        name: string;
        type: string;
        describe: string;
        startTime: number;
      };
    }
  | {
      type: "delDeriveAsset";
      data: {
        assetsId: number;
        id: number;
      };
    }
  | {
      type: "generateDeriveAsset";
      data: {
        ids: number[];
      };
    }
  | {
      type: "generateStoryboard";
      data: {
        ids: number[];
      };
    }
  | {
      type: "addStoryboard";
      data: {
        videoDesc: string;
        prompt: string | null;
        track: string;
        duration: number;
        associateAssetsIds: number[];
        shouldGenerateImage: string;
      };
    };
