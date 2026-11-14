package io.github.zhenyufu039.playtime;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

public class RuntimeBundleTest {
    static class FakeAssets implements RuntimeBundle.Assets {
        boolean fail = true;
        int opens = 0;
        public String[] list(String path) {
            // The marker deliberately comes first, as it does in the packaged APK.
            return path.equals("playtime") ? new String[]{"BUILD_STAMP", "app.py", "web"} :
                path.equals("playtime/web") ? new String[]{"app.js"} : new String[0];
        }
        public InputStream open(String path) throws IOException {
            opens++;
            if (fail && path.equals("playtime/web/app.js")) throw new IOException("Interrupted copy");
            return new ByteArrayInputStream((path.endsWith("BUILD_STAMP") ? "new-build" : path).getBytes(StandardCharsets.UTF_8));
        }
    }
    static void require(boolean condition) { if (!condition) throw new AssertionError(); }
    public static void main(String[] args) throws Exception {
        File runtime = new File(args[0], "runtime"), data = new File(args[0], "data");
        data.mkdirs();Files.write(new File(data, "personal.json").toPath(), "keep".getBytes(StandardCharsets.UTF_8));
        FakeAssets assets = new FakeAssets();
        try { RuntimeBundle.install(assets, runtime); throw new AssertionError("Expected interruption"); }
        catch (IOException expected) { require(expected.getMessage().equals("Interrupted copy")); }
        require(!new File(runtime, "BUILD_STAMP").exists());
        require(new File(runtime, "app.py").exists());
        assets.fail = false;RuntimeBundle.install(assets, runtime);
        require(new File(runtime, "web/app.js").isFile());
        require(new String(Files.readAllBytes(new File(runtime, "BUILD_STAMP").toPath()), StandardCharsets.UTF_8).equals("new-build"));
        int before = assets.opens;RuntimeBundle.install(assets, runtime);require(assets.opens == before + 1);
        Files.write(new File(runtime, "BUILD_STAMP").toPath(), "partial".getBytes(StandardCharsets.UTF_8));
        RuntimeBundle.install(assets, runtime);require(assets.opens > before + 2);
        require(new String(Files.readAllBytes(new File(data, "personal.json").toPath()), StandardCharsets.UTF_8).equals("keep"));
        System.out.println("PASS: interrupted unpack, retry, complete marker, unchanged build, separate personal data");
    }
}
