package com.livevoice.build;

import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;

/** Pin one playback boundary, without changing WebRTC's native library or audio routing. */
public final class PlaybackTapVisitor extends ClassVisitor {
    private int replacements;

    public PlaybackTapVisitor(ClassVisitor next) {
        super(Opcodes.ASM9, next);
    }

    @Override
    public MethodVisitor visitMethod(int access, String name, String descriptor,
                                     String signature, String[] exceptions) {
        MethodVisitor next = super.visitMethod(access, name, descriptor, signature, exceptions);
        if (!name.equals("run") || !descriptor.equals("()V")) return next;
        return new MethodVisitor(Opcodes.ASM9, next) {
            @Override
            public void visitMethodInsn(int opcode, String owner, String method,
                                        String desc, boolean isInterface) {
                if (opcode == Opcodes.INVOKEVIRTUAL && owner.equals("android/media/AudioTrack")
                        && method.equals("write") && desc.equals("(Ljava/nio/ByteBuffer;II)I")) {
                    replacements++;
                    super.visitMethodInsn(Opcodes.INVOKESTATIC,
                            "com/livevoiceapp/recording/RecordingAudioTap", "write",
                            "(Landroid/media/AudioTrack;Ljava/nio/ByteBuffer;II)I", false);
                } else {
                    super.visitMethodInsn(opcode, owner, method, desc, isInterface);
                }
            }
        };
    }

    @Override
    public void visitEnd() {
        if (replacements != 1) {
            throw new IllegalStateException("WebRTC playback boundary changed; review recording integration before updating WebRTC");
        }
        super.visitEnd();
    }
}
